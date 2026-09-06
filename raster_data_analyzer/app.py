"""
GeoPixel Studio - Modern Raster Data Analyzer
=============================================
Flask backend for GeoTIFF upload, metadata inspection, grid sampling,
min-max normalization and export (CSV / PNG / GeoTIFF).
"""

import io
import os
import csv
import uuid
import traceback

import numpy as np
import rasterio
from rasterio.enums import Resampling
from werkzeug.utils import secure_filename
from flask import (
    Flask, render_template, request, jsonify, session, send_file, abort
)
from PIL import Image

# ---------------------------------------------------------------------------
# App configuration
# ---------------------------------------------------------------------------

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
OUTPUT_DIR = os.path.join(BASE_DIR, "outputs")

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

TIFF_EXTENSIONS = {".tif", ".tiff"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp"}
ALLOWED_EXTENSIONS = TIFF_EXTENSIONS | IMAGE_EXTENSIONS
MAX_CONTENT_LENGTH = 100 * 1024 * 1024  # 100 MB
MIN_GRID = 5
MAX_GRID = 60

app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, "app", "templates"),
    static_folder=os.path.join(BASE_DIR, "app", "static"),
)
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH
app.secret_key = os.environ.get("GEOPIXEL_SECRET_KEY", "geopixel-studio-dev-secret-key")


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def allowed_file(filename):
    """Check that the uploaded filename has a supported raster extension."""
    ext = os.path.splitext(filename)[1].lower()
    return ext in ALLOWED_EXTENSIONS


def error_response(message, status=400):
    """Return a consistent, user-friendly JSON error payload."""
    return jsonify({"success": False, "error": message}), status


def clamp_grid_dim(value, default=30):
    """Keep grid dimensions inside the supported 5-60 range."""
    try:
        value = int(value)
    except (TypeError, ValueError):
        return default
    return max(MIN_GRID, min(MAX_GRID, value))


def safe_float(value):
    """Convert numpy scalars to plain JSON-friendly floats, guarding NaN/Inf."""
    if value is None:
        return None
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    if np.isnan(value) or np.isinf(value):
        return None
    return value


def get_dataset_path():
    """Fetch the current session's uploaded raster path, validating it exists."""
    path = session.get("raster_path")
    if not path or not os.path.exists(path):
        return None
    return path


def get_normalized_path():
    path = session.get("normalized_path")
    if not path or not os.path.exists(path):
        return None
    return path


def convert_image_to_tiff(source_path, output_path):
    """
    Convert any supported everyday image format (JPG, PNG, BMP, GIF, WEBP)
    into a plain TIFF file so the rest of the raster pipeline (rasterio-based
    metadata reading, grid sampling, normalization) can treat every upload
    identically. Palette-based images are flattened to real pixel values
    first so bands hold genuine intensities rather than palette indices.
    """
    with Image.open(source_path) as img:
        if img.mode == "P":
            img = img.convert("RGBA") if "transparency" in img.info else img.convert("RGB")
        elif img.mode not in ("L", "LA", "RGB", "RGBA", "I", "I;16", "F"):
            img = img.convert("RGB")
        img.save(output_path, format="TIFF")


# ---------------------------------------------------------------------------
# Raster analysis helpers
# ---------------------------------------------------------------------------

def read_full_metadata(path):
    """Read raster-wide metadata (dimensions, CRS, dtype, nodata, band count)."""
    with rasterio.open(path) as src:
        nodata = src.nodata
        return {
            "width": src.width,
            "height": src.height,
            "count": src.count,
            "crs": str(src.crs) if src.crs else "Not defined",
            "dtype": src.dtypes[0],
            "nodata": safe_float(nodata) if nodata is not None else None,
        }


def compute_band_stats(path, band):
    """Compute min/max/mean for a single band using masked (NoData-aware) reads."""
    with rasterio.open(path) as src:
        if band < 1 or band > src.count:
            raise ValueError("Invalid band index.")
        arr = src.read(band, masked=True)

    # Guard against all-NaN / fully masked bands
    valid = arr.compressed() if hasattr(arr, "compressed") else np.asarray(arr).ravel()
    valid = valid[np.isfinite(valid)] if valid.size else valid

    if valid.size == 0:
        return {"min": None, "max": None, "mean": None, "valid_pixels": 0}

    return {
        "min": safe_float(np.min(valid)),
        "max": safe_float(np.max(valid)),
        "mean": safe_float(np.mean(valid)),
        "valid_pixels": int(valid.size),
    }


def build_sampled_grid(path, band, rows, cols):
    """
    Build a small representative grid (<=60x60) by asking rasterio to
    decimate the raster directly at read time (out_shape), which avoids
    ever loading the full-resolution array into memory just for preview.
    """
    with rasterio.open(path) as src:
        if band < 1 or band > src.count:
            raise ValueError("Invalid band index.")

        data = src.read(
            band,
            out_shape=(rows, cols),
            resampling=Resampling.average,
            masked=True,
        )

    grid = []
    for r in range(data.shape[0]):
        row_values = []
        for c in range(data.shape[1]):
            cell = data[r, c]
            if np.ma.is_masked(cell) or not np.isfinite(cell):
                row_values.append(None)
            else:
                row_values.append(round(float(cell), 4))
        grid.append(row_values)
    return grid


def normalize_raster_full_resolution(source_path, output_path):
    """
    Core GIS operation: read the ORIGINAL full-resolution raster, normalize
    every band independently with min-max scaling, and write a new GeoTIFF
    that preserves width, height, band count, CRS and affine transform.

    Returns a small summary (per-band min/max) used by the frontend.
    """
    band_summary = []

    with rasterio.open(source_path) as src:
        profile = src.profile.copy()
        profile.update(dtype="float32", nodata=np.nan, compress="deflate")

        normalized_bands = []
        for band_idx in range(1, src.count + 1):
            arr = src.read(band_idx, masked=True).astype("float64")
            valid = arr.compressed()
            valid = valid[np.isfinite(valid)] if valid.size else valid

            if valid.size == 0:
                # Entire band is NoData - keep it fully masked/NaN.
                result = np.full(arr.shape, np.nan, dtype="float32")
                band_summary.append({"band": band_idx, "min": None, "max": None})
                normalized_bands.append(result)
                continue

            band_min = float(np.min(valid))
            band_max = float(np.max(valid))
            band_summary.append({"band": band_idx, "min": band_min, "max": band_max})

            if band_max == band_min:
                # Constant-value raster: avoid division by zero.
                # Every valid pixel maps to the middle of the range (0.5).
                scaled = np.where(np.ma.getmaskarray(arr), np.nan, 0.5)
            else:
                raw = (arr.astype("float64") - band_min) / (band_max - band_min)
                raw = np.clip(raw, 0.0, 1.0)
                scaled = np.where(np.ma.getmaskarray(arr), np.nan, raw)

            normalized_bands.append(scaled.astype("float32"))

        with rasterio.open(output_path, "w", **profile) as dst:
            for i, band_arr in enumerate(normalized_bands, start=1):
                dst.write(band_arr, i)

    return band_summary


def array_to_csv_bytes(grid):
    """Serialize a 2D grid (list of lists, values or None) into CSV bytes."""
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["row", "col", "value"])
    for r, row in enumerate(grid, start=1):
        for c, value in enumerate(row, start=1):
            writer.writerow([r, c, "" if value is None else value])
    return buffer.getvalue().encode("utf-8")


# ---------------------------------------------------------------------------
# Color palettes (implemented without extra dependencies)
# ---------------------------------------------------------------------------

PALETTES = {
    "viridis": [
        (0.00, (68, 1, 84)),
        (0.25, (59, 82, 139)),
        (0.50, (33, 145, 140)),
        (0.75, (94, 201, 98)),
        (1.00, (253, 231, 37)),
    ],
    "turbo": [
        (0.00, (48, 18, 59)),
        (0.20, (65, 121, 246)),
        (0.40, (43, 208, 195)),
        (0.60, (146, 244, 78)),
        (0.80, (250, 176, 41)),
        (1.00, (122, 4, 3)),
    ],
    "grayscale": [
        (0.00, (20, 20, 20)),
        (1.00, (245, 245, 245)),
    ],
    "terrain": [
        (0.00, (25, 60, 130)),
        (0.30, (40, 140, 90)),
        (0.55, (170, 190, 70)),
        (0.75, (150, 110, 70)),
        (1.00, (250, 250, 250)),
    ],
}


def palette_color(t, stops):
    """Linearly interpolate an RGB color for t in [0, 1] across color stops."""
    t = max(0.0, min(1.0, t))
    for i in range(len(stops) - 1):
        p0, c0 = stops[i]
        p1, c1 = stops[i + 1]
        if p0 <= t <= p1:
            span = (p1 - p0) or 1.0
            ratio = (t - p0) / span
            r = c0[0] + (c1[0] - c0[0]) * ratio
            g = c0[1] + (c1[1] - c0[1]) * ratio
            b = c0[2] + (c1[2] - c0[2]) * ratio
            return int(r), int(g), int(b)
    return stops[-1][1]


def grid_to_png_bytes(grid, palette_name="viridis", nodata_color=(30, 34, 46)):
    """
    Render a grid (list of lists of float/None) to a PNG image using the
    requested color palette. Values are stretched to their own min/max so
    both raw and normalized grids produce a legible visualization.
    """
    stops = PALETTES.get(palette_name, PALETTES["viridis"])

    flat = [v for row in grid for v in row if v is not None]
    if not flat:
        v_min, v_max = 0.0, 1.0
    else:
        v_min, v_max = min(flat), max(flat)

    rows = len(grid)
    cols = len(grid[0]) if rows else 0

    img = Image.new("RGB", (cols, rows), color=nodata_color)
    pixels = img.load()

    span = (v_max - v_min) or 1.0
    for r in range(rows):
        for c in range(cols):
            value = grid[r][c]
            if value is None:
                pixels[c, r] = nodata_color
            else:
                t = (value - v_min) / span
                pixels[c, r] = palette_color(t, stops)

    # Upscale so small grids (e.g. 30x30) are still visible in the browser.
    scale = max(1, 512 // max(cols, rows, 1))
    if scale > 1:
        img = img.resize((cols * scale, rows * scale), Image.NEAREST)

    out = io.BytesIO()
    img.save(out, format="PNG")
    out.seek(0)
    return out


# ---------------------------------------------------------------------------
# Routes - pages
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# Routes - API
# ---------------------------------------------------------------------------

@app.route("/api/read-raster", methods=["POST"])
def api_read_raster():
    """Handle upload + validation + initial metadata extraction."""
    try:
        if "file" not in request.files:
            return error_response("No file was uploaded. Please choose a GeoTIFF file.")

        file = request.files["file"]
        if file.filename == "":
            return error_response("No file selected. Please choose a GeoTIFF file.")

        if not allowed_file(file.filename):
            return error_response(
                "Unsupported file type. Accepted formats: GeoTIFF (.tif, .tiff) and "
                "images (.jpg, .jpeg, .png, .bmp, .gif, .webp) — images are auto-converted to TIFF."
            )

        filename = secure_filename(file.filename)
        stored_name = f"{uuid.uuid4().hex}_{filename}"
        stored_path = os.path.join(UPLOAD_DIR, stored_name)
        file.save(stored_path)

        # Non-TIFF images (JPG/PNG/BMP/GIF/WEBP) are converted to a real TIFF
        # file first, so every downstream step (metadata, stats, grid
        # sampling, normalization) always operates on an actual TIFF raster.
        ext = os.path.splitext(filename)[1].lower()
        if ext in IMAGE_EXTENSIONS:
            base_no_ext = os.path.splitext(filename)[0]
            tiff_stored_name = f"{uuid.uuid4().hex}_{base_no_ext}.tif"
            tiff_stored_path = os.path.join(UPLOAD_DIR, tiff_stored_name)
            try:
                convert_image_to_tiff(stored_path, tiff_stored_path)
            except Exception:
                os.remove(stored_path)
                return error_response(
                    "Unable to convert the uploaded image into a TIFF raster."
                )
            os.remove(stored_path)
            stored_path = tiff_stored_path
            filename = f"{base_no_ext}.tif"

        # Validate that the file is actually a readable raster.
        try:
            metadata = read_full_metadata(stored_path)
        except Exception:
            os.remove(stored_path)
            return error_response(
                "Unable to process this raster. Please check that the file is a valid GeoTIFF."
            )

        if metadata["width"] <= 0 or metadata["height"] <= 0 or metadata["count"] <= 0:
            os.remove(stored_path)
            return error_response("The uploaded raster appears to be empty or corrupted.")

        # First-band stats for the initial display.
        try:
            band_stats = compute_band_stats(stored_path, 1)
        except Exception:
            band_stats = {"min": None, "max": None, "mean": None, "valid_pixels": 0}

        session["raster_path"] = stored_path
        session["raster_original_name"] = filename
        session.pop("normalized_path", None)

        return jsonify({
            "success": True,
            "filename": filename,
            "metadata": metadata,
            "band": 1,
            "stats": band_stats,
        })

    except Exception:
        return error_response(
            "Unable to process this raster. Please check that the file is a valid GeoTIFF."
        )


@app.route("/api/band-stats", methods=["POST"])
def api_band_stats():
    """Return statistics for a specific band of the currently loaded raster."""
    try:
        path = get_dataset_path()
        if not path:
            return error_response("No raster is currently loaded. Please upload a GeoTIFF first.")

        payload = request.get_json(silent=True) or {}
        band = int(payload.get("band", 1))

        stats = compute_band_stats(path, band)
        return jsonify({"success": True, "band": band, "stats": stats})

    except ValueError as exc:
        return error_response(str(exc))
    except Exception:
        return error_response("Unable to compute band statistics for this raster.")


@app.route("/api/build-grid", methods=["POST"])
def api_build_grid():
    """Build a small representative sampled grid for the raw pixel view."""
    try:
        path = get_dataset_path()
        if not path:
            return error_response("No raster is currently loaded. Please upload a GeoTIFF first.")

        payload = request.get_json(silent=True) or {}
        band = int(payload.get("band", 1))
        rows = clamp_grid_dim(payload.get("rows", 30))
        cols = clamp_grid_dim(payload.get("cols", 30))

        grid = build_sampled_grid(path, band, rows, cols)

        session["grid_rows"] = rows
        session["grid_cols"] = cols
        session["grid_band"] = band

        return jsonify({
            "success": True,
            "grid": grid,
            "rows": rows,
            "cols": cols,
            "band": band,
        })

    except ValueError as exc:
        return error_response(str(exc))
    except Exception:
        return error_response("Unable to build the raster grid. Please check the row/column values.")


@app.route("/api/normalize", methods=["POST"])
def api_normalize():
    """Run full-resolution, per-band min-max normalization and write a GeoTIFF."""
    try:
        path = get_dataset_path()
        if not path:
            return error_response("No raster is currently loaded. Please upload a GeoTIFF first.")

        payload = request.get_json(silent=True) or {}
        band = int(payload.get("band", session.get("grid_band", 1)))
        rows = clamp_grid_dim(payload.get("rows", session.get("grid_rows", 30)))
        cols = clamp_grid_dim(payload.get("cols", session.get("grid_cols", 30)))

        original_name = session.get("raster_original_name", "raster.tif")
        base_name = os.path.splitext(original_name)[0]
        output_name = f"{uuid.uuid4().hex}_{base_name}_normalized.tif"
        output_path = os.path.join(OUTPUT_DIR, output_name)

        band_summary = normalize_raster_full_resolution(path, output_path)

        session["normalized_path"] = output_path
        session["normalized_download_name"] = f"{base_name}_normalized.tif"

        normalized_grid = build_sampled_grid(output_path, band, rows, cols)

        return jsonify({
            "success": True,
            "band_summary": band_summary,
            "normalized_grid": normalized_grid,
            "rows": rows,
            "cols": cols,
            "band": band,
            "download_filename": output_name,
        })

    except Exception:
        return error_response(
            "Normalization failed. Please verify the raster contains valid pixel data."
        )


@app.route("/api/export-csv")
def api_export_csv():
    """Export the raw or normalized grid as a downloadable CSV file."""
    try:
        grid_type = request.args.get("type", "raw")
        band = int(request.args.get("band", 1))
        rows = clamp_grid_dim(request.args.get("rows", 30))
        cols = clamp_grid_dim(request.args.get("cols", 30))

        if grid_type == "normalized":
            path = get_normalized_path()
            if not path:
                return error_response("Please normalize the raster before exporting normalized data.")
        else:
            path = get_dataset_path()
            if not path:
                return error_response("No raster is currently loaded. Please upload a GeoTIFF first.")

        grid = build_sampled_grid(path, band, rows, cols)
        csv_bytes = array_to_csv_bytes(grid)

        return send_file(
            io.BytesIO(csv_bytes),
            mimetype="text/csv",
            as_attachment=True,
            download_name=f"geopixel_{grid_type}_grid.csv",
        )

    except ValueError as exc:
        return error_response(str(exc))
    except Exception:
        return error_response("Unable to generate the CSV export.")


@app.route("/api/export-png")
def api_export_png():
    """Export the raw or normalized grid as a downloadable, color-mapped PNG."""
    try:
        grid_type = request.args.get("type", "raw")
        band = int(request.args.get("band", 1))
        rows = clamp_grid_dim(request.args.get("rows", 30))
        cols = clamp_grid_dim(request.args.get("cols", 30))
        palette = request.args.get("palette", "viridis")
        if palette not in PALETTES:
            palette = "viridis"

        if grid_type == "normalized":
            path = get_normalized_path()
            if not path:
                return error_response("Please normalize the raster before exporting normalized data.")
        else:
            path = get_dataset_path()
            if not path:
                return error_response("No raster is currently loaded. Please upload a GeoTIFF first.")

        grid = build_sampled_grid(path, band, rows, cols)
        png_buffer = grid_to_png_bytes(grid, palette_name=palette)

        return send_file(
            png_buffer,
            mimetype="image/png",
            as_attachment=True,
            download_name=f"geopixel_{grid_type}_grid.png",
        )

    except ValueError as exc:
        return error_response(str(exc))
    except Exception:
        return error_response("Unable to generate the PNG export.")


@app.route("/download/<path:filename>")
def download_file(filename):
    """Serve a previously generated normalized GeoTIFF for download."""
    safe_name = secure_filename(filename)
    file_path = os.path.join(OUTPUT_DIR, safe_name)

    normalized_path = get_normalized_path()
    if not normalized_path or os.path.basename(normalized_path) != safe_name:
        # Only allow downloading the file this session actually produced.
        abort(404)

    if not os.path.exists(file_path):
        abort(404)

    download_name = session.get("normalized_download_name", safe_name)
    return send_file(file_path, as_attachment=True, download_name=download_name)


# ---------------------------------------------------------------------------
# Error handlers
# ---------------------------------------------------------------------------

@app.errorhandler(413)
def too_large(_error):
    return error_response("File is too large. Maximum upload size is 100 MB.", 413)


@app.errorhandler(404)
def not_found(_error):
    if request.path.startswith("/api/"):
        return error_response("The requested resource was not found.", 404)
    return render_template("index.html"), 200


@app.errorhandler(500)
def server_error(_error):
    return error_response("An unexpected server error occurred. Please try again.", 500)


if __name__ == "__main__":
    debug_mode = os.environ.get("FLASK_DEBUG", "1") == "1"
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=debug_mode)
