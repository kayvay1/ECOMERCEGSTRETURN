/* ============================================================
   APP STATE + UI WIRING
   ============================================================ */
(function(){
  'use strict';

  const state = {
    gstin: '',
    periodType: 'monthly', // 'monthly' | 'quarterly'
    months: [],            // array of { year, month } objects, e.g. [{year:2026, month:5}]
    fp: '',                // final filing period string e.g. "052026" or "062026" for quarter-end
    platforms: new Set(),  // 'meeso' | 'flipkart'
    files: {},             // meeso: `${year}-${month}-sales` / `-return` -> {fileName, rows}
                            // flipkart: `${year}-${month}-flipkart` -> {fileName, sheets}
    result: null
  };

  // -------------------- DOM SHORTCUTS --------------------
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  const toastEl = $('#toast');
  function toast(msg, type){
    toastEl.textContent = msg;
    toastEl.className = 'toast is-visible' + (type ? ' is-' + type : '');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => { toastEl.className = 'toast'; }, 3200);
  }

  // -------------------- STEP NAVIGATION --------------------
  function goToStep(n){
    $$('.step-card').forEach(c => c.classList.toggle('is-active', c.dataset.stepPanel === String(n)));
    $$('.rail-step').forEach(r => {
      const stepNum = Number(r.dataset.step);
      r.classList.toggle('is-active', stepNum === n);
      r.classList.toggle('is-done', stepNum < n);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  $$('.rail-step').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = Number(btn.dataset.step);
      // Only allow jumping to a step that's been unlocked (done) or the current logical next one
      if (target <= getMaxUnlockedStep()) goToStep(target);
    });
  });

  $$('[data-back]').forEach(btn => {
    btn.addEventListener('click', () => goToStep(Number(btn.dataset.back)));
  });

  function getMaxUnlockedStep(){
    if (state.result) return 4;
    if (state.platforms.size && Object.keys(state.files).length) return 3;
    if (state.fp) return 2;
    return 1;
  }

  // -------------------- STEP 1: GSTIN --------------------
  const gstinInput = $('#gstinInput');
  const gstinHint = $('#gstinHint');
  const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

  gstinInput.addEventListener('input', () => {
    gstinInput.value = gstinInput.value.toUpperCase().replace(/[^0-9A-Z]/g, '');
    validateGstin();
  });

  function validateGstin(){
    const v = gstinInput.value.trim();
    if (v.length === 0){
      gstinHint.textContent = '15 characters · first 2 digits = state code';
      gstinHint.className = 'field-hint';
      gstinInput.classList.remove('is-invalid');
      return false;
    }
    if (GSTIN_RE.test(v)){
      const stateCode = v.substring(0, 2);
      gstinHint.textContent = `✓ Valid format · home state code ${stateCode}`;
      gstinHint.className = 'field-hint is-ok';
      gstinInput.classList.remove('is-invalid');
      return true;
    } else {
      gstinHint.textContent = v.length < 15 ? `${v.length}/15 characters` : 'Doesn\'t match GSTIN format — double check it';
      gstinHint.className = v.length === 15 ? 'field-hint is-error' : 'field-hint';
      gstinInput.classList.toggle('is-invalid', v.length === 15);
      return false;
    }
  }

  $('#toStep2').addEventListener('click', () => {
    const v = gstinInput.value.trim();
    $('#showgstnumber').textContent = v;
    if (v.length !== 15){
      toast('GSTIN must be exactly 15 characters', 'error');
      gstinInput.focus();
      return;
    }
    if (!GSTIN_RE.test(v)){
      toast('That doesn\'t look like a valid GSTIN format', 'error');
      gstinInput.focus();
      return;
    }
    state.gstin = v;
    goToStep(2);
  });

  // -------------------- STEP 2: PERIOD --------------------
  const monthlyPicker = $('#monthlyPicker');
  const quarterlyPicker = $('#quarterlyPicker');
  const monthInput = $('#monthInput');
  const quarterSelect = $('#quarterSelect');
  const quarterYearInput = $('#quarterYearInput');

  $$('[data-period-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('[data-period-type]').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.periodType = btn.dataset.periodType;
      monthlyPicker.classList.toggle('is-hidden', state.periodType !== 'monthly');
      quarterlyPicker.classList.toggle('is-hidden', state.periodType !== 'quarterly');
    });
  });

  const QUARTER_MONTHS = { Q1: [4,5,6], Q2: [7,8,9], Q3: [10,11,12], Q4: [1,2,3] };

  function pad2(n){ return String(n).padStart(2, '0'); }

  $('#toStep3').addEventListener('click', () => {
    state.months = [];

    if (state.periodType === 'monthly'){
      if (!monthInput.value){
        toast('Pick a filing month first', 'error');
        return;
      }
      const [y, m] = monthInput.value.split('-').map(Number);
      state.months = [{ year: y, month: m }];
      state.fp = `${pad2(m)}${y}`;
    } else {
      const q = quarterSelect.value;
      const fy = Number(quarterYearInput.value);
      if (!q){
        toast('Pick a quarter', 'error');
        return;
      }
      if (!fy || fy < 2017 || fy > 2099){
        toast('Enter a valid financial year', 'error');
        return;
      }
      const monthsInQ = QUARTER_MONTHS[q];
      // Q4 (Jan-Mar) belongs to the calendar year AFTER the FY start year
      const calYearForMonths = m => (q === 'Q4' ? fy + 1 : fy);
      state.months = monthsInQ.map(m => ({ year: calYearForMonths(m), month: m }));
      const lastMonth = monthsInQ[monthsInQ.length - 1];
      const lastYear = calYearForMonths(lastMonth);
      state.fp = `${pad2(lastMonth)}${lastYear}`;
    }

    buildUploadGroups();
    goToStep(3);
  });

  const MONTH_NAMES = ['', 'January','February','March','April','May','June','July','August','September','October','November','December'];

  // -------------------- STEP 3: PLATFORM SELECT + UPLOAD --------------------
  const platformGrid = $('#platformGrid');
  const uploadInstructionsWrap = $('#uploadInstructionsWrap');
  const uploadGroups = $('#uploadGroups');
  const uploadInstructions = $('#uploadInstructions');
  const toStep4Btn = $('#toStep4');

  $$('.platform-card:not(.is-disabled)').forEach(card => {
    card.addEventListener('click', () => {
      const platform = card.dataset.platform;
      if (state.platforms.has(platform)) {
        state.platforms.delete(platform);
        card.classList.remove('is-selected');
      } else {
        state.platforms.add(platform);
        card.classList.add('is-selected');
      }
      buildUploadGroups();
    });
  });

  function buildUploadGroups(){
    uploadGroups.innerHTML = '';
    state.files = {};

    if (state.platforms.size === 0){
      uploadInstructionsWrap.classList.add('is-hidden');
      toStep4Btn.disabled = true;
      return;
    }
    uploadInstructionsWrap.classList.remove('is-hidden');

    const platformNames = Array.from(state.platforms).map(p => p[0].toUpperCase() + p.slice(1));
    uploadInstructions.innerHTML = `Upload the ${platformNames.join(' + ')} file${state.months.length > 1 ? 's' : ''} for ${state.months.length > 1 ? 'each month in this quarter' : 'the selected month'} below.`;

    state.months.forEach(({ year, month }) => {
      const monthGroup = document.createElement('div');
      monthGroup.className = 'upload-month-group';

      let innerHtml = `<h3 class="upload-month-title">${MONTH_NAMES[month]} ${year} <span class="month-chip">${pad2(month)}${year}</span></h3>`;

      if (state.platforms.has('meeso')){
        const key = `${year}-${month}`;
        innerHtml += `
          <div class="platform-section-label"><span class="platform-section-icon">🛍️</span> Meeso</div>
          <div class="dropzone-row">
            <div class="dropzone" data-key="${key}" data-kind="meeso-sales">
              <span class="dz-tag">required</span>
              <span class="dz-icon">📦</span>
              <span class="dz-label">tcs_sales.xlsx</span>
              <span class="dz-sub" data-role="filename">drop file or click to browse</span>
              <input type="file" accept=".xlsx,.xls" data-key="${key}" data-kind="meeso-sales">
            </div>
            <div class="dropzone is-optional" data-key="${key}" data-kind="meeso-return">
              <span class="dz-tag">optional</span>
              <span class="dz-icon">↩️</span>
              <span class="dz-label">tcs_sales_return.xlsx</span>
              <span class="dz-sub" data-role="filename">drop file or click to browse</span>
              <input type="file" accept=".xlsx,.xls" data-key="${key}" data-kind="meeso-return">
            </div>
          </div>
        `;
      }

      if (state.platforms.has('flipkart')){
        const key = `${year}-${month}`;
        innerHtml += `
          <div class="platform-section-label"><span class="platform-section-icon">📦</span> Flipkart</div>
          <div class="platform-section-note">One workbook — the GSTR-1/GSTR-8 export with Section 7(A)(2), 7(B)(2), 12, 13 and Section 3 in GSTR-8.</div>
          <div class="dropzone-row">
            <div class="dropzone" data-key="${key}" data-kind="flipkart">
              <span class="dz-tag">required</span>
              <span class="dz-icon">📊</span>
              <span class="dz-label">Flipkart GSTR export.xlsx</span>
              <span class="dz-sub" data-role="filename">drop file or click to browse</span>
              <input type="file" accept=".xlsx,.xls" data-key="${key}" data-kind="flipkart">
            </div>
          </div>
        `;
      }

      if (state.platforms.has('amazon')){
        const key = `${year}-${month}`;
        innerHtml += `
          <div class="platform-section-label"><span class="platform-section-icon">📮</span> Amazon</div>
          <div class="platform-section-note">Amazon GSTR-1 Ready-to-File export — ek hi workbook jisme B2C Small, HSN Summary aur B2B sheets hoti hain.</div>
          <div class="dropzone-row">
            <div class="dropzone" data-key="${key}" data-kind="amazon">
              <span class="dz-tag">required</span>
              <span class="dz-icon">📊</span>
              <span class="dz-label">Amazon GSTR-1 export.xlsx</span>
              <span class="dz-sub" data-role="filename">drop file or click to browse</span>
              <input type="file" accept=".xlsx,.xls" data-key="${key}" data-kind="amazon">
            </div>
          </div>
        `;
      }

      monthGroup.innerHTML = innerHtml;
      uploadGroups.appendChild(monthGroup);
    });

    wireDropzones();
    updateStep4Availability();
  }

  function wireDropzones(){
    $$('.dropzone').forEach(zone => {
      const input = zone.querySelector('input[type="file"]');
      const key = zone.dataset.key;
      const kind = zone.dataset.kind;

      input.addEventListener('change', () => {
        if (input.files && input.files[0]) handleFile(input.files[0], key, kind, zone);
      });

      zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('is-dragover'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('is-dragover'));
      zone.addEventListener('drop', e => {
        e.preventDefault();
        zone.classList.remove('is-dragover');
        const f = e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) handleFile(f, key, kind, zone);
      });
    });
  }

  const FLIPKART_SHEET_NAMES = [
    'Section 7(A)(2) in GSTR-1',
    'Section 7(B)(2) in GSTR-1',
    'Section 12 in GSTR-1',
    'Section 13 in GSTR-1',
    'Section 3 in GSTR-8'
  ];

  const AMAZON_SHEET_NAMES = ['B2C Small', 'HSN Summary', 'B2B'];

  const MEESO_REQUIRED_COLS = ['hsn_code','quantity','gst_rate','total_taxable_sale_value','taxable_shipping','end_customer_state_new'];

  function handleFile(file, key, kind, zone){
    const validExt = /\.(xlsx|xls)$/i.test(file.name);
    if (!validExt){
      toast('Please upload an .xlsx or .xls file', 'error');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array' });

        if (kind === 'flipkart'){
          const sheets = {};
          let foundAny = false;
          FLIPKART_SHEET_NAMES.forEach(name => {
            if (wb.Sheets[name]){
              // Some Flipkart exports ship with a wrong !ref (e.g. "A1:IV1") that
              // only covers the header row — sheet_to_json then returns no data rows.
              // Fix: rebuild !ref from the actual cell addresses present in the sheet.
              const ws = wb.Sheets[name];
              const cellKeys = Object.keys(ws).filter(k => !k.startsWith('!'));
              if (cellKeys.length > 0){
                const decoded = cellKeys.map(k => XLSX.utils.decode_cell(k));
                const maxRow = Math.max(...decoded.map(c => c.r));
                const maxCol = Math.max(...decoded.map(c => c.c));
                ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxRow, c: maxCol } });
              }
              sheets[name] = XLSX.utils.sheet_to_json(ws, { defval: null });
              foundAny = true;
            }
          });
          if (!foundAny){
            toast(`${file.name} doesn't look like a Flipkart GSTR export — expected sheets like "Section 7(A)(2) in GSTR-1"`, 'error');
            return;
          }
          state.files[`${key}-flipkart`] = { fileName: file.name, sheets };
          zone.classList.add('has-file');
          zone.querySelector('[data-role="filename"]').textContent = `✓ ${file.name}`;
          toast(`Loaded ${file.name}`, 'success');
          updateStep4Availability();
          return;
        }

        if (kind === 'amazon'){
          const sheets = {};
          let foundAny = false;
          AMAZON_SHEET_NAMES.forEach(name => {
            if (wb.Sheets[name]){
              // Amazon header is at row 4 (index 3) — use range:3
              // !ref is correct in Amazon files so no override needed
              sheets[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null, range: 3 });
              foundAny = true;
            }
          });
          if (!foundAny){
            toast(`${file.name} doesn't look like an Amazon GSTR-1 export — expected sheets like "B2C Small", "HSN Summary"`, 'error');
            return;
          }
          state.files[`${key}-amazon`] = { fileName: file.name, sheets };
          zone.classList.add('has-file');
          zone.querySelector('[data-role="filename"]').textContent = `✓ ${file.name}`;
          toast(`Loaded ${file.name}`, 'success');
          updateStep4Availability();
          return;
        }

        // Meeso sales / return files
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

        if (!rows.length){
          toast(`${file.name} looks empty`, 'error');
          return;
        }

        const missing = MEESO_REQUIRED_COLS.filter(c => !(c in rows[0]));
        if (missing.length){
          toast(`${file.name} is missing columns: ${missing.join(', ')}`, 'error');
          return;
        }

        state.files[`${key}-${kind}`] = { fileName: file.name, rows };

        zone.classList.add('has-file');
        zone.querySelector('[data-role="filename"]').textContent = `✓ ${file.name} · ${rows.length} rows`;
        toast(`Loaded ${file.name} (${rows.length} rows)`, 'success');
        updateStep4Availability();
      } catch (err){
        console.error(err);
        toast('Could not parse that file — is it a valid Excel export?', 'error');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function updateStep4Availability(){
    if (state.platforms.size === 0){ toStep4Btn.disabled = true; return; }

    const allRequiredPresent = state.months.every(({ year, month }) => {
      const key = `${year}-${month}`;
      let ok = true;
      if (state.platforms.has('meeso'))    ok = ok && !!state.files[`${key}-meeso-sales`];
      if (state.platforms.has('flipkart')) ok = ok && !!state.files[`${key}-flipkart`];
      if (state.platforms.has('amazon'))   ok = ok && !!state.files[`${key}-amazon`];
      return ok;
    });
    toStep4Btn.disabled = !allRequiredPresent;
  }

  toStep4Btn.addEventListener('click', () => {
    runConversion();
  });

  // -------------------- CONVERSION --------------------
  function runConversion(){
    const platformsInput = {};

    if (state.platforms.has('meeso')){
      let allSalesRows = [];
      let allReturnRows = [];
      state.months.forEach(({ year, month }) => {
        const key = `${year}-${month}`;
        const salesEntry = state.files[`${key}-meeso-sales`];
        const returnEntry = state.files[`${key}-meeso-return`];
        if (salesEntry) allSalesRows = allSalesRows.concat(salesEntry.rows);
        if (returnEntry) allReturnRows = allReturnRows.concat(returnEntry.rows);
      });
      platformsInput.meeso = { salesRows: allSalesRows, returnRows: allReturnRows };
    }

    if (state.platforms.has('flipkart')){
      // Merge sheets across months: concatenate row arrays for each sheet name,
      // since multiple months means multiple Flipkart files to combine.
      const mergedSheets = {};
      FLIPKART_SHEET_NAMES.forEach(name => { mergedSheets[name] = []; });

      state.months.forEach(({ year, month }) => {
        const key = `${year}-${month}`;
        const entry = state.files[`${key}-flipkart`];
        if (entry){
          FLIPKART_SHEET_NAMES.forEach(name => {
            if (entry.sheets[name]) mergedSheets[name] = mergedSheets[name].concat(entry.sheets[name]);
          });
        }
      });
      platformsInput.flipkart = { sheets: mergedSheets };
    }

    if (state.platforms.has('amazon')){
      const mergedSheets = {};
      AMAZON_SHEET_NAMES.forEach(name => { mergedSheets[name] = []; });
      state.months.forEach(({ year, month }) => {
        const entry = state.files[`${year}-${month}-amazon`];
        if (entry){
          AMAZON_SHEET_NAMES.forEach(name => {
            if (entry.sheets[name]) mergedSheets[name] = mergedSheets[name].concat(entry.sheets[name]);
          });
        }
      });
      platformsInput.amazon = { sheets: mergedSheets };
    }

    const result = convertMultiPlatform(platformsInput, { gstin: state.gstin, fp: state.fp });
    state.result = result;

    renderReview(result);
    goToStep(4);
  }

  // -------------------- STEP 4: REVIEW --------------------
  function renderReview(result){
    const { json, warnings, stats } = result;

    $('#statGrid').innerHTML = `
      <div class="stat-card"><span class="stat-label">Taxable Value</span><span class="stat-value">₹${fmt(stats.totalTaxableValue)}</span></div>
      <div class="stat-card"><span class="stat-label">IGST</span><span class="stat-value">₹${fmt(stats.totalIgst)}</span></div>
      <div class="stat-card"><span class="stat-label">CGST</span><span class="stat-value">₹${fmt(stats.totalCgst)}</span></div>
      <div class="stat-card"><span class="stat-label">SGST</span><span class="stat-value">₹${fmt(stats.totalSgst)}</span></div>
      <div class="stat-card"><span class="stat-label">States Filed</span><span class="stat-value">${stats.statesCount}</span></div>
      <div class="stat-card"><span class="stat-label">HSN Lines</span><span class="stat-value">${stats.hsnCount}</span></div>
      <div class="stat-card"><span class="stat-label">Sales Rows</span><span class="stat-value">${stats.totalSalesRows}</span></div>
      <div class="stat-card"><span class="stat-label">Net Invoices</span><span class="stat-value">${stats.netIssue}</span></div>
    `;

    const warningsBox = $('#warningsBox');
    if (warnings.length){
      warningsBox.style.display = 'block';
      warningsBox.innerHTML = warnings.map(w => `⚠️ ${escapeHtml(w)}`).join('<br>');
    } else {
      warningsBox.style.display = 'none';
    }

    // B2CS table
    const b2csTable = $('#b2csTable');
    b2csTable.innerHTML = `
      <thead><tr><th>POS</th><th>Supply Type</th><th>Rate</th><th>Taxable Value</th><th>IGST</th><th>CGST</th><th>SGST</th></tr></thead>
      <tbody>${json.b2cs.map(b => `
        <tr>
          <td>${b.pos}</td>
          <td class="${b.sply_ty === 'INTRA' ? 'tag-intra' : 'tag-inter'}">${b.sply_ty}</td>
          <td>${b.rt}%</td>
          <td>${fmt(b.txval)}</td>
          <td>${fmt(b.iamt)}</td>
          <td>${fmt(b.camt)}</td>
          <td>${fmt(b.samt)}</td>
        </tr>`).join('')}
      </tbody>
    `;

    // HSN table
    const hsnTable = $('#hsnTable');
    hsnTable.innerHTML = `
      <thead><tr><th>HSN</th><th>UQC</th><th>Qty</th><th>Rate</th><th>Taxable Value</th><th>IGST</th><th>CGST</th><th>SGST</th></tr></thead>
      <tbody>${json.hsn.hsn_b2c.map(h => `
        <tr>
          <td>${h.hsn_sc}</td>
          <td>${h.uqc}</td>
          <td>${h.qty}</td>
          <td>${h.rt}%</td>
          <td>${fmt(h.txval)}</td>
          <td>${fmt(h.iamt)}</td>
          <td>${fmt(h.camt)}</td>
          <td>${fmt(h.samt)}</td>
        </tr>`).join('')}
      </tbody>
    `;

    $('#jsonView').textContent = JSON.stringify(json, null, 2);
  }

  function fmt(n){
    return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function escapeHtml(s){
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // -------------------- TABS --------------------
  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab-btn').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      $$('.tab-panel').forEach(p => p.classList.toggle('is-active', p.dataset.tabPanel === btn.dataset.tab));
    });
  });

  // -------------------- DOWNLOAD / COPY --------------------
  $('#downloadJsonBtn').addEventListener('click', () => {
    if (!state.result) return;
    const blob = new Blob([JSON.stringify(state.result.json, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gstr1_${state.fp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('Downloaded gstr1_' + state.fp + '.json', 'success');
  });

  $('#copyJsonBtn').addEventListener('click', () => {
    if (!state.result) return;
    navigator.clipboard.writeText(JSON.stringify(state.result.json, null, 2))
      .then(() => toast('JSON copied to clipboard', 'success'))
      .catch(() => toast('Could not copy — try downloading instead', 'error'));
  });

  // init
  validateGstin();
  goToStep(1);
})();
