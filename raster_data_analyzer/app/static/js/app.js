/* =============================================================
   GeoPixel Studio — Frontend logic (vanilla JavaScript, fetch API)
   ============================================================= */

(function () {
  "use strict";

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  const state = {
    hasRaster: false,
    bandCount: 1,
    currentBand: 1,
    rows: 30,
    cols: 30,
    rawGrid: null,
    normalizedGrid: null,
    isNormalized: false,
    palette: "viridis",
    normalizedDownloadFilename: null,
  };

  // ------------------------------------------------------------------
  // Element references
  // ------------------------------------------------------------------
  const el = {
    dropzone: document.getElementById("dropzone"),
    fileInput: document.getElementById("fileInput"),
    browseBtn: document.getElementById("browseBtn"),
    fileMetaRow: document.getElementById("fileMetaRow"),
    fileNameLabel: document.getElementById("fileNameLabel"),
    fileSizeLabel: document.getElementById("fileSizeLabel"),
    uploadProgressTrack: document.getElementById("uploadProgressTrack"),
    uploadProgressFill: document.getElementById("uploadProgressFill"),
    uploadError: document.getElementById("uploadError"),
    systemStatus: document.getElementById("systemStatus"),

    statWidth: document.getElementById("statWidth"),
    statHeight: document.getElementById("statHeight"),
    statBands: document.getElementById("statBands"),
    statCrs: document.getElementById("statCrs"),
    statDtype: document.getElementById("statDtype"),
    statNodata: document.getElementById("statNodata"),

    bandSelect: document.getElementById("bandSelect"),
    rowsInput: document.getElementById("rowsInput"),
    colsInput: document.getElementById("colsInput"),
    buildGridBtn: document.getElementById("buildGridBtn"),
    bandMin: document.getElementById("bandMin"),
    bandMax: document.getElementById("bandMax"),
    bandMean: document.getElementById("bandMean"),
    controlsError: document.getElementById("controlsError"),

    rawLabelsToggle: document.getElementById("rawLabelsToggle"),
    rawValuesToggle: document.getElementById("rawValuesToggle"),
    downloadRawCsvBtn: document.getElementById("downloadRawCsvBtn"),
    downloadRawPngBtn: document.getElementById("downloadRawPngBtn"),
    rawGridPlaceholder: document.getElementById("rawGridPlaceholder"),
    rawGridTable: document.getElementById("rawGridTable"),

    normalizeBtn: document.getElementById("normalizeBtn"),
    normalizeProgressTrack: document.getElementById("normalizeProgressTrack"),
    normalizeProgressFill: document.getElementById("normalizeProgressFill"),
    normalizeProgressCaption: document.getElementById("normalizeProgressCaption"),
    normalizeError: document.getElementById("normalizeError"),
    normalizeSuccess: document.getElementById("normalizeSuccess"),

    paletteSelect: document.getElementById("paletteSelect"),
    normLabelsToggle: document.getElementById("normLabelsToggle"),
    normValuesToggle: document.getElementById("normValuesToggle"),
    downloadNormCsvBtn: document.getElementById("downloadNormCsvBtn"),
    downloadNormPngBtn: document.getElementById("downloadNormPngBtn"),
    normGridPlaceholder: document.getElementById("normGridPlaceholder"),
    normGridTable: document.getElementById("normGridTable"),
    downloadGeoTiffBtn: document.getElementById("downloadGeoTiffBtn"),

    toastStack: document.getElementById("toastStack"),
  };

  // ------------------------------------------------------------------
  // Utilities
  // ------------------------------------------------------------------

  function showToast(message, type) {
    const toast = document.createElement("div");
    toast.className = "toast " + (type === "error" ? "error" : "success");
    toast.textContent = message;
    el.toastStack.appendChild(toast);
    setTimeout(() => toast.remove(), 4200);
  }

  function showError(box, message) {
    box.textContent = message;
    box.hidden = false;
  }

  function hideError(box) {
    box.hidden = true;
    box.textContent = "";
  }

  function formatBytes(bytes) {
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }

  function fmt(value, decimals = 3) {
    if (value === null || value === undefined) return "N/A";
    const num = Number(value);
    if (Number.isNaN(num)) return "N/A";
    return num.toFixed(decimals);
  }

  async function postJSON(url, payload) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    let data;
    try {
      data = await response.json();
    } catch (err) {
      throw new Error("Unexpected server response. Please try again.");
    }
    if (!response.ok || !data.success) {
      throw new Error(data.error || "Something went wrong. Please try again.");
    }
    return data;
  }

  // ------------------------------------------------------------------
  // Upload handling (drag & drop + browse)
  // ------------------------------------------------------------------

  el.browseBtn.addEventListener("click", () => el.fileInput.click());
  el.dropzone.addEventListener("click", (e) => {
    if (e.target === el.browseBtn) return;
    el.fileInput.click();
  });

  ["dragenter", "dragover"].forEach((evt) => {
    el.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      el.dropzone.classList.add("dragover");
    });
  });

  ["dragleave", "drop"].forEach((evt) => {
    el.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      el.dropzone.classList.remove("dragover");
    });
  });

  el.dropzone.addEventListener("drop", (e) => {
    const files = e.dataTransfer.files;
    if (files && files.length) handleFileUpload(files[0]);
  });

  el.fileInput.addEventListener("change", (e) => {
    if (e.target.files && e.target.files.length) {
      handleFileUpload(e.target.files[0]);
    }
  });

  const ACCEPTED_EXTENSIONS = [
    ".tif", ".tiff", ".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp",
  ];

  function validateClientSide(file) {
    const name = file.name.toLowerCase();
    const isAccepted = ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext));
    if (!isAccepted) {
      return "Unsupported file type. Accepted formats: GeoTIFF (.tif, .tiff) and images (.jpg, .jpeg, .png, .bmp, .gif, .webp).";
    }
    if (file.size > 100 * 1024 * 1024) {
      return "File is too large. Maximum upload size is 100 MB.";
    }
    return null;
  }

  function handleFileUpload(file) {
    hideError(el.uploadError);

    const clientError = validateClientSide(file);
    if (clientError) {
      showError(el.uploadError, clientError);
      return;
    }

    el.fileMetaRow.hidden = false;
    el.fileNameLabel.textContent = file.name;
    el.fileSizeLabel.textContent = formatBytes(file.size);

    el.uploadProgressTrack.hidden = false;
    el.uploadProgressFill.style.width = "0%";
    el.systemStatus.textContent = "Uploading...";

    const formData = new FormData();
    formData.append("file", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/read-raster");

    xhr.upload.addEventListener("progress", (evt) => {
      if (evt.lengthComputable) {
        const pct = Math.round((evt.loaded / evt.total) * 100);
        el.uploadProgressFill.style.width = pct + "%";
      }
    });

    xhr.onload = () => {
      let data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (err) {
        data = { success: false, error: "Unexpected server response." };
      }

      if (xhr.status >= 200 && xhr.status < 300 && data.success) {
        el.uploadProgressFill.style.width = "100%";
        el.systemStatus.textContent = "Raster Loaded";
        onUploadSuccess(data);
        showToast("File uploaded successfully.", "success");
      } else {
        el.systemStatus.textContent = "System Ready";
        showError(el.uploadError, data.error || "Upload failed. Please try again.");
        showToast(data.error || "Upload failed.", "error");
      }
      setTimeout(() => { el.uploadProgressTrack.hidden = true; }, 600);
    };

    xhr.onerror = () => {
      el.systemStatus.textContent = "System Ready";
      el.uploadProgressTrack.hidden = true;
      showError(el.uploadError, "Network error while uploading. Please try again.");
    };

    xhr.send(formData);
  }

  function onUploadSuccess(data) {
    resetWorkspaceForNewRaster();

    state.hasRaster = true;
    state.bandCount = data.metadata.count;
    state.currentBand = 1;

    el.statWidth.textContent = data.metadata.width;
    el.statHeight.textContent = data.metadata.height;
    el.statBands.textContent = data.metadata.count;
    el.statCrs.textContent = data.metadata.crs;
    el.statDtype.textContent = data.metadata.dtype;
    el.statNodata.textContent = data.metadata.nodata === null ? "Not defined" : data.metadata.nodata;

    // Populate band selector.
    el.bandSelect.innerHTML = "";
    for (let i = 1; i <= data.metadata.count; i++) {
      const option = document.createElement("option");
      option.value = i;
      option.textContent = "Band " + i;
      el.bandSelect.appendChild(option);
    }
    el.bandSelect.disabled = false;
    el.rowsInput.disabled = false;
    el.colsInput.disabled = false;
    el.buildGridBtn.disabled = false;
    el.normalizeBtn.disabled = false;

    updateBandStatsDisplay(data.stats);
  }

  function resetWorkspaceForNewRaster() {
    state.rawGrid = null;
    state.normalizedGrid = null;
    state.isNormalized = false;
    state.normalizedDownloadFilename = null;

    el.rawGridTable.hidden = true;
    el.rawGridPlaceholder.hidden = false;
    el.rawGridPlaceholder.textContent = "Build a grid to preview raw pixel values.";
    el.normGridTable.hidden = true;
    el.normGridPlaceholder.hidden = false;
    el.normGridPlaceholder.textContent = "Normalize the raster to preview standardized values.";

    el.downloadRawCsvBtn.disabled = true;
    el.downloadRawPngBtn.disabled = true;
    el.downloadNormCsvBtn.disabled = true;
    el.downloadNormPngBtn.disabled = true;
    el.downloadGeoTiffBtn.hidden = true;

    hideError(el.normalizeError);
    el.normalizeSuccess.hidden = true;
  }

  // ------------------------------------------------------------------
  // Band selection
  // ------------------------------------------------------------------

  el.bandSelect.addEventListener("change", async () => {
    state.currentBand = parseInt(el.bandSelect.value, 10);
    hideError(el.controlsError);

    try {
      const data = await postJSON("/api/band-stats", { band: state.currentBand });
      updateBandStatsDisplay(data.stats);
    } catch (err) {
      showError(el.controlsError, err.message);
    }

    // Rebuild whichever grids already exist, for the newly selected band.
    if (state.rawGrid) await buildGrid(false);
    if (state.isNormalized) await refreshNormalizedGridForCurrentSelection();
  });

  function updateBandStatsDisplay(stats) {
    el.bandMin.textContent = fmt(stats.min);
    el.bandMax.textContent = fmt(stats.max);
    el.bandMean.textContent = fmt(stats.mean);
  }

  // ------------------------------------------------------------------
  // Grid building (raw grid)
  // ------------------------------------------------------------------

  el.buildGridBtn.addEventListener("click", () => buildGrid(true));

  async function buildGrid(announce) {
    hideError(el.controlsError);

    let rows = parseInt(el.rowsInput.value, 10);
    let cols = parseInt(el.colsInput.value, 10);
    if (Number.isNaN(rows) || rows < 5 || rows > 60 || Number.isNaN(cols) || cols < 5 || cols > 60) {
      showError(el.controlsError, "Rows and columns must be between 5 and 60.");
      return;
    }

    try {
      const data = await postJSON("/api/build-grid", {
        band: state.currentBand,
        rows: rows,
        cols: cols,
      });

      state.rawGrid = data.grid;
      state.rows = data.rows;
      state.cols = data.cols;

      renderGrid(el.rawGridTable, el.rawGridPlaceholder, state.rawGrid, {
        showLabels: el.rawLabelsToggle.checked,
        showValues: el.rawValuesToggle.checked,
        heatmap: false,
      });

      el.downloadRawCsvBtn.disabled = false;
      el.downloadRawPngBtn.disabled = false;

      if (state.isNormalized) {
        await refreshNormalizedGridForCurrentSelection();
      }

      if (announce) showToast("Grid built successfully.", "success");
    } catch (err) {
      showError(el.controlsError, err.message);
    }
  }

  el.rawLabelsToggle.addEventListener("change", rerenderRawGrid);
  el.rawValuesToggle.addEventListener("change", rerenderRawGrid);

  function rerenderRawGrid() {
    if (!state.rawGrid) return;
    renderGrid(el.rawGridTable, el.rawGridPlaceholder, state.rawGrid, {
      showLabels: el.rawLabelsToggle.checked,
      showValues: el.rawValuesToggle.checked,
      heatmap: false,
    });
  }

  // ------------------------------------------------------------------
  // Normalization
  // ------------------------------------------------------------------

  el.normalizeBtn.addEventListener("click", async () => {
    hideError(el.normalizeError);
    el.normalizeSuccess.hidden = true;

    const rows = state.rawGrid ? state.rows : (parseInt(el.rowsInput.value, 10) || 30);
    const cols = state.rawGrid ? state.cols : (parseInt(el.colsInput.value, 10) || 30);

    el.normalizeBtn.disabled = true;
    el.normalizeProgressTrack.hidden = false;
    animateFakeProgress();

    try {
      const data = await postJSON("/api/normalize", {
        band: state.currentBand,
        rows: rows,
        cols: cols,
      });

      state.isNormalized = true;
      state.normalizedGrid = data.normalized_grid;
      state.rows = data.rows;
      state.cols = data.cols;
      state.normalizedDownloadFilename = data.download_filename;

      renderGrid(el.normGridTable, el.normGridPlaceholder, state.normalizedGrid, {
        showLabels: el.normLabelsToggle.checked,
        showValues: el.normValuesToggle.checked,
        heatmap: true,
        palette: state.palette,
      });

      el.downloadNormCsvBtn.disabled = false;
      el.downloadNormPngBtn.disabled = false;
      el.downloadGeoTiffBtn.hidden = false;
      el.downloadGeoTiffBtn.href = "/download/" + encodeURIComponent(data.download_filename);

      finishFakeProgress(true);
      el.normalizeSuccess.hidden = false;
      el.normalizeSuccess.textContent = "Full-resolution normalization complete. All bands processed and preserved.";
      showToast("Raster normalized successfully.", "success");
    } catch (err) {
      finishFakeProgress(false);
      showError(el.normalizeError, err.message);
      showToast(err.message, "error");
    } finally {
      el.normalizeBtn.disabled = false;
    }
  });

  let progressTimer = null;

  function animateFakeProgress() {
    let pct = 0;
    el.normalizeProgressFill.style.width = "0%";
    el.normalizeProgressCaption.textContent = "Processing full-resolution raster array... 0%";
    clearInterval(progressTimer);
    progressTimer = setInterval(() => {
      pct = Math.min(pct + Math.random() * 12, 92);
      el.normalizeProgressFill.style.width = pct.toFixed(0) + "%";
      el.normalizeProgressCaption.textContent =
        "Processing full-resolution raster array... " + pct.toFixed(0) + "%";
    }, 220);
  }

  function finishFakeProgress(success) {
    clearInterval(progressTimer);
    el.normalizeProgressFill.style.width = "100%";
    el.normalizeProgressCaption.textContent = success
      ? "Processing full-resolution raster array... 100%"
      : "Processing failed.";
    setTimeout(() => { el.normalizeProgressTrack.hidden = true; }, 700);
  }

  async function refreshNormalizedGridForCurrentSelection() {
    try {
      const data = await postJSON("/api/normalize", {
        band: state.currentBand,
        rows: state.rows,
        cols: state.cols,
      });
      state.normalizedGrid = data.normalized_grid;
      renderGrid(el.normGridTable, el.normGridPlaceholder, state.normalizedGrid, {
        showLabels: el.normLabelsToggle.checked,
        showValues: el.normValuesToggle.checked,
        heatmap: true,
        palette: state.palette,
      });
    } catch (err) {
      showError(el.normalizeError, err.message);
    }
  }

  el.normLabelsToggle.addEventListener("change", rerenderNormGrid);
  el.normValuesToggle.addEventListener("change", rerenderNormGrid);
  el.paletteSelect.addEventListener("change", () => {
    state.palette = el.paletteSelect.value;
    rerenderNormGrid();
  });

  function rerenderNormGrid() {
    if (!state.normalizedGrid) return;
    renderGrid(el.normGridTable, el.normGridPlaceholder, state.normalizedGrid, {
      showLabels: el.normLabelsToggle.checked,
      showValues: el.normValuesToggle.checked,
      heatmap: true,
      palette: state.palette,
    });
  }

  // ------------------------------------------------------------------
  // Grid rendering
  // ------------------------------------------------------------------

  const PALETTE_STOPS = {
    viridis: [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]],
    turbo: [[48, 18, 59], [65, 121, 246], [43, 208, 195], [146, 244, 78], [250, 176, 41], [122, 4, 3]],
    grayscale: [[20, 20, 20], [245, 245, 245]],
    terrain: [[25, 60, 130], [40, 140, 90], [170, 190, 70], [150, 110, 70], [250, 250, 250]],
  };

  function paletteColor(t, stops) {
    t = Math.max(0, Math.min(1, t));
    const segments = stops.length - 1;
    const scaled = t * segments;
    const idx = Math.min(Math.floor(scaled), segments - 1);
    const ratio = scaled - idx;
    const c0 = stops[idx];
    const c1 = stops[idx + 1];
    const r = Math.round(c0[0] + (c1[0] - c0[0]) * ratio);
    const g = Math.round(c0[1] + (c1[1] - c0[1]) * ratio);
    const b = Math.round(c0[2] + (c1[2] - c0[2]) * ratio);
    return `rgb(${r}, ${g}, ${b})`;
  }

  function renderGrid(table, placeholder, grid, options) {
    if (!grid || !grid.length) {
      table.hidden = true;
      placeholder.hidden = false;
      return;
    }

    placeholder.hidden = true;
    table.hidden = false;
    table.innerHTML = "";

    const rows = grid.length;
    const cols = grid[0].length;

    let flatValues = [];
    if (options.heatmap) {
      grid.forEach((row) => row.forEach((v) => { if (v !== null) flatValues.push(v); }));
    }
    const vMin = flatValues.length ? Math.min(...flatValues) : 0;
    const vMax = flatValues.length ? Math.max(...flatValues) : 1;
    const span = (vMax - vMin) || 1;
    const stops = PALETTE_STOPS[options.palette] || PALETTE_STOPS.viridis;

    if (options.showLabels) {
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      headRow.appendChild(document.createElement("th"));
      for (let c = 1; c <= cols; c++) {
        const th = document.createElement("th");
        th.textContent = "C" + c;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);
    }

    const tbody = document.createElement("tbody");
    for (let r = 0; r < rows; r++) {
      const tr = document.createElement("tr");

      if (options.showLabels) {
        const rowLabel = document.createElement("td");
        rowLabel.className = "row-label";
        rowLabel.textContent = "R" + (r + 1);
        tr.appendChild(rowLabel);
      }

      for (let c = 0; c < cols; c++) {
        const td = document.createElement("td");
        const value = grid[r][c];

        if (value === null) {
          td.classList.add("nodata-cell");
          if (options.showValues) td.textContent = "NoData";
        } else {
          if (options.showValues) {
            td.textContent = options.heatmap ? value.toFixed(3) : value.toFixed(2);
          }
          if (options.heatmap) {
            const t = (value - vMin) / span;
            td.style.background = paletteColor(t, stops);
          }
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }

  // ------------------------------------------------------------------
  // Exports (CSV / PNG / GeoTIFF)
  // ------------------------------------------------------------------

  function buildExportUrl(base, type) {
    const params = new URLSearchParams({
      type: type,
      band: state.currentBand,
      rows: state.rows,
      cols: state.cols,
    });
    if (base.includes("png")) params.set("palette", state.palette);
    return base + "?" + params.toString();
  }

  function triggerDownload(url) {
    const link = document.createElement("a");
    link.href = url;
    link.click();
  }

  el.downloadRawCsvBtn.addEventListener("click", () => {
    triggerDownload(buildExportUrl("/api/export-csv", "raw"));
  });
  el.downloadRawPngBtn.addEventListener("click", () => {
    triggerDownload(buildExportUrl("/api/export-png", "raw"));
  });
  el.downloadNormCsvBtn.addEventListener("click", () => {
    triggerDownload(buildExportUrl("/api/export-csv", "normalized"));
  });
  el.downloadNormPngBtn.addEventListener("click", () => {
    triggerDownload(buildExportUrl("/api/export-png", "normalized"));
  });

  // ------------------------------------------------------------------
  // KaTeX rendering (formula display)
  // ------------------------------------------------------------------

  window.addEventListener("load", () => {
    if (window.renderMathInElement) {
      renderMathInElement(document.body, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
        ],
      });
    }
  });
})();
