/* ============================================================
   MULTI-PLATFORM → GSTR1 CONVERSION ENGINE
   Pure functions, no DOM. Each platform (Meeso, Flipkart, ...)
   has its own parser that turns raw uploaded rows into a common
   normalized shape. A single merge step combines all platforms
   into the final GSTR1 JSON, since the portal does not allow two
   separate entries for the same POS+rate (b2cs) or same HSN+rate
   (hsn summary) — everything must be netted into one row.
   ============================================================ */

const STATE_CODE_MAP = {
  'JAMMU AND KASHMIR': '01', 'JAMMU & KASHMIR': '01',
  'HIMACHAL PRADESH': '02',
  'PUNJAB': '03',
  'CHANDIGARH': '04',
  'UTTARAKHAND': '05',
  'HARYANA': '06',
  'DELHI': '07',
  'RAJASTHAN': '08',
  'UTTAR PRADESH': '09',
  'BIHAR': '10',
  'SIKKIM': '11',
  'ARUNACHAL PRADESH': '12',
  'NAGALAND': '13',
  'MANIPUR': '14',
  'MIZORAM': '15',
  'TRIPURA': '16',
  'MEGHALAYA': '17',
  'ASSAM': '18',
  'WEST BENGAL': '19',
  'JHARKHAND': '20',
  'ODISHA': '21', 'ORISSA': '21',
  'CHHATTISGARH': '22', 'CHATTISGARH': '22',
  'MADHYA PRADESH': '23',
  'GUJARAT': '24',
  'DAMAN AND DIU': '25',
  'DAMAN': '26', 'THE DADRA AND NAGAR HAVELI AND DAMAN AND DIU': '26', 'DADRA & NAGAR HAVELI AND DAMAN & DIU': '26', 'DADRA AND NAGAR HAVELI': '26',
  'MAHARASHTRA': '27',
  'KARNATAKA': '29',
  'GOA': '30',
  'LAKSHADWEEP': '31',
  'KERALA': '32',
  'TAMIL NADU': '33',
  'PONDICHERRY': '34',
  'ANDAMAN AND NICOBAR ISLANDS': '35', 'ANDAMAN & NICOBAR': '35', 'ANDAMAN & NICOBAR ISLANDS': '35',
  'TELANGANA': '36',
  'ANDHRA PRADESH': '37',
  'LADAKH': '38', 'LEH LADAKH': '38',
  'OTHER TERRITORY': '97',
  'CENTER JURISDICTION': '99'
};

// Known e-commerce operator GSTINs, used as a fallback if a file doesn't carry its own.
const PLATFORM_ETIN = {
  meeso: '24AARCM9332R1CU',
  flipkart: '24AACCF0683K1ZN',
  amazon: '24AAICA3918J1CZ'
};

function homeStateFromGSTIN(gstin) {
  if (!gstin || gstin.length < 2) return null;
  return gstin.substring(0, 2);
}

function normalizeStateName(name) {
  if (name === null || name === undefined) return '';
  return String(name).trim().toUpperCase().replace(/\s+/g, ' ');
}

function resolvePOS(stateName) {
  const norm = normalizeStateName(stateName);
  return STATE_CODE_MAP[norm] || null;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function numOr0(v) {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

// Excel headers sometimes carry embedded \r\n or extra spaces (e.g. "Invoice Series \r\nTo").
// This builds a lookup that's tolerant of that by collapsing all whitespace before matching.
function normalizeKey(k) {
  return String(k).replace(/\s+/g, ' ').trim().toLowerCase();
}

function getCol(row, ...candidates) {
  if (!row) return undefined;
  const normalizedMap = {};
  Object.keys(row).forEach(k => { normalizedMap[normalizeKey(k)] = row[k]; });
  for (const c of candidates) {
    const v = normalizedMap[normalizeKey(c)];
    if (v !== undefined) return v;
  }
  return undefined;
}

/* ============================================================
   COMMON INTERMEDIATE SHAPE produced by every platform parser:
   {
     b2csRows: [{ pos, rate, taxval }],     // one row per source line, net sign already applied (returns are negative)
     hsnRows:  [{ hsn, qty, taxval, rate?, pos?, presetTax? }],
     docIssue: { from, to, totnum, cancel, netIssue },
     supecoMeta: { etin, platform },
     supecoTotals: { suppval, igst, cgst, sgst, cess } | null,
     warnings: [string],
     rowCounts: { sales, returns }
   }
   ============================================================ */

// -----------------------------------------------------------
// MEESO PARSER
// -----------------------------------------------------------
function normalizeMeesoRow(raw) {
  const hsn = String(raw.hsn_code ?? '').trim();
  const qty = numOr0(raw.quantity);
  const rate = numOr0(raw.gst_rate);
  const taxableSale = numOr0(raw.total_taxable_sale_value);
  const taxableShipping = numOr0(raw.taxable_shipping);
  const taxval = taxableSale + taxableShipping;
  const stateName = raw.end_customer_state_new;
  const pos = resolvePOS(stateName);
  return { hsn, qty, rate, taxval, pos, stateNameRaw: stateName };
}

function parseMeeso(salesRows, returnRows) {
  const warnings = [];
  const unmapped = new Set();
  const b2csRows = [];
  const hsnRows = [];

  const pushRow = (raw, sign) => {
    const n = normalizeMeesoRow(raw);
    if (!n.pos) {
      unmapped.add(n.stateNameRaw || '(blank)');
      return;
    }
    b2csRows.push({ pos: n.pos, rate: n.rate, taxval: sign * n.taxval });
    hsnRows.push({ hsn: n.hsn, qty: sign * n.qty, taxval: sign * n.taxval, rate: n.rate, pos: n.pos });
  };

  salesRows.forEach(r => pushRow(r, 1));
  returnRows.forEach(r => pushRow(r, -1));

  if (unmapped.size > 0) {
    warnings.push(`Meeso: ${unmapped.size} row(s) had an unrecognized state and were excluded: ${Array.from(unmapped).join(', ')}`);
  }

  const totalSalesRows = salesRows.length;
  const totalReturnRows = returnRows.length;
  const netIssue = Math.max(totalSalesRows - totalReturnRows, 0);

  let etin = PLATFORM_ETIN.meeso;
  const sampleRow = salesRows.find(r => r.eco_tcs_gstin) || returnRows.find(r => r.eco_tcs_gstin);
  if (sampleRow && sampleRow.eco_tcs_gstin) etin = String(sampleRow.eco_tcs_gstin).trim();

  return {
    b2csRows,
    hsnRows,
    docIssue: { from: '1', to: String(totalSalesRows), totnum: totalSalesRows, cancel: totalReturnRows, netIssue },
    supecoMeta: { etin, platform: 'meeso' },
    supecoTotals: null, // derived from b2csRows during merge
    warnings,
    rowCounts: { sales: totalSalesRows, returns: totalReturnRows }
  };
}

// -----------------------------------------------------------
// FLIPKART PARSER
// Reads 5 worksheets from the Flipkart GSTR-1/GSTR-8 export:
//   "Section 7(A)(2) in GSTR-1" — intra-state aggregate (no PoS column; always home state)
//   "Section 7(B)(2) in GSTR-1" — inter-state aggregate, has "Delivered State (PoS)"
//   "Section 12 in GSTR-1"      — HSN summary, already split by igst/cgst/sgst
//   "Section 13 in GSTR-1"      — invoice series (doc issue)
//   "Section 3 in GSTR-8"       — TCS / supeco block, carries Flipkart's own GSTIN
// `sheets` param: { sheetName: Array<rowObject> } as produced by SheetJS sheet_to_json
// -----------------------------------------------------------
function parseFlipkart(sheets, homeState) {
  const warnings = [];
  const unmapped = new Set();
  const b2csRows = [];
  const hsnRows = [];

  const interRows = sheets['Section 7(B)(2) in GSTR-1'] || [];
  const intraRows = sheets['Section 7(A)(2) in GSTR-1'] || [];
  const hsnSheetRows = sheets['Section 12 in GSTR-1'] || [];
  const docRows = sheets['Section 13 in GSTR-1'] || [];
  const supecoRows = sheets['Section 3 in GSTR-8'] || [];

  // Helper: true only for actual data rows, not re-appearing header rows
  // When 3 monthly files are concatenated, each file's header row appears as a
  // "data row" — we filter them out by checking the GSTIN field is a real GSTIN
  // (15 alphanumeric chars) and NOT the literal string "GSTIN".
  const isDataRow = (r) => {
    const g = getCol(r, 'GSTIN');
    if (!g) return false;
    const s = String(g).trim();
    if (s.toUpperCase() === 'GSTIN') return false; // it's a repeated header row
    return s.length > 0;
  };

  // --- 7(B)(2): inter-state, has its own PoS column ---
  interRows.filter(isDataRow).forEach(r => {
    const taxval = numOr0(getCol(r, 'Aggregate Taxable Value Rs.'));
    const rate = numOr0(getCol(r, 'IGST %'));
    const stateName = getCol(r, 'Delivered State (PoS)');
    const pos = resolvePOS(stateName);
    if (!pos) {
      unmapped.add(stateName || '(blank)');
      return;
    }
    if (Math.abs(taxval) < 0.005) return;
    b2csRows.push({ pos, rate, taxval });
  });

  // --- 7(A)(2): intra-state, no PoS column — it's the supplier's home state by definition ---
  intraRows.filter(isDataRow).forEach(r => {
    const taxval = numOr0(getCol(r, 'Aggregate Taxable Value Rs.'));
    const cgstRate = numOr0(getCol(r, 'CGST %'));
    const rate = round2(cgstRate * 2); // GST rate = CGST% + SGST% (always equal halves)
    if (Math.abs(taxval) < 0.005) return;
    if (!homeState) {
      warnings.push('Flipkart: intra-state sheet has data but home state could not be detected from GSTIN.');
      return;
    }
    b2csRows.push({ pos: homeState, rate, taxval });
  });

  // --- Section 12: HSN summary ---
  // For quarterly filing, 3 months of HSN rows are concatenated — each month's
  // row for the same HSN must be summed, not treated as separate entries.
  hsnSheetRows.filter(isDataRow).forEach(r => {
    const hsn = String(getCol(r, 'HSN Number') ?? '').trim();
    if (!hsn) return;
    const qty = numOr0(getCol(r, 'Total Quantity in Nos.'));
    const taxval = numOr0(getCol(r, 'Total Taxable Value Rs.'));
    const igst = numOr0(getCol(r, 'IGST Amount Rs.'));
    const cgst = numOr0(getCol(r, 'CGST Amount Rs.'));
    const sgst = numOr0(getCol(r, 'SGST Amount Rs.'));
    // Push each month row individually — the hsnBuckets merge in mergePlatforms
    // will sum them all into one entry per HSN, so no duplicates reach the portal.
    hsnRows.push({ hsn, qty, taxval, presetTax: { igst, cgst, sgst } });
  });

  // --- Section 13: invoice series / doc issue ---
  // Quarterly = 3 monthly files → 3 rows. Sum totnum/cancel/net_issue across all
  // months; use first month's "from" and last month's "to" as the series range.
  const docDataRows = docRows.filter(isDataRow);
  let docIssue = null;
  if (docDataRows.length > 0) {
    const totalNum = docDataRows.reduce((s, r) => s + numOr0(getCol(r, 'Total Number of Invoices')), 0);
    const totalCancel = docDataRows.reduce((s, r) => s + numOr0(getCol(r, 'Cancelled if any')), 0);
    const totalNet = docDataRows.reduce((s, r) => s + numOr0(getCol(r, 'Net invoices Issued')), 0);
    docIssue = {
      from: String(getCol(docDataRows[0], 'Invoice Series From') ?? ''),
      to: String(getCol(docDataRows[docDataRows.length - 1], 'Invoice Series To') ?? ''),
      totnum: totalNum,
      cancel: totalCancel,
      netIssue: totalNet
    };
  }

  // --- Section 3 in GSTR-8: TCS / supeco block ---
  // Quarterly = 3 monthly rows → SUM all taxable values and tax amounts across months.
  let etin = PLATFORM_ETIN.flipkart;
  let supecoTotals = null;
  const supecoDataRows = supecoRows.filter(isDataRow);
  if (supecoDataRows.length > 0) {
    // ETIN (Flipkart's GSTIN) is the same across all months — take from first row
    const flipkartGstin = getCol(supecoDataRows[0], 'GSTIN of Flipkart.Com');
    if (flipkartGstin) etin = String(flipkartGstin).trim();
    supecoTotals = {
      suppval: round2(supecoDataRows.reduce((s, r) => s + numOr0(getCol(r, 'Net Taxable Value')), 0)),
      igst:    round2(supecoDataRows.reduce((s, r) => s + numOr0(getCol(r, 'IGST Amount Rs.')), 0)),
      cgst:    round2(supecoDataRows.reduce((s, r) => s + numOr0(getCol(r, 'CGST Amount Rs.')), 0)),
      sgst:    round2(supecoDataRows.reduce((s, r) => s + numOr0(getCol(r, 'SGST Amount Rs.')), 0)),
      cess:    round2(supecoDataRows.reduce((s, r) => s + numOr0(getCol(r, 'Cess Amount Rs.') ?? getCol(r, 'CESS Amount Rs.')), 0))
    };
  }

  if (unmapped.size > 0) {
    warnings.push(`Flipkart: ${unmapped.size} row(s) had an unrecognized state and were excluded: ${Array.from(unmapped).join(', ')}`);
  }

  return {
    b2csRows,
    hsnRows,
    docIssue,
    supecoMeta: { etin, platform: 'flipkart' },
    supecoTotals,
    warnings,
    rowCounts: { sales: interRows.length + intraRows.length, returns: 0 }
  };
}

/* ============================================================
   AMAZON PARSER
   Reads 3 worksheets from the Amazon GSTR-1 Ready-to-File export:
     "B2C Small"   — B2CS data (row 4 = header, row 5+ = data)
     "HSN Summary" — HSN data (row 4 = header, row 5+ = data)
     "B2B"         — B2B invoices (row 4 = header, mostly blank)
   Key differences from Flipkart:
     - Rate is in DECIMAL form: 0.05 = 5%, multiply × 100
     - Place Of Supply format: "29-Karnataka" → first 2 chars = POS code
     - No separate TCS summary sheet — supeco totals derived from B2CS rows
     - Header is at row index 3 (0-based), so SheetJS range:3 is used
   `sheets` param: { sheetName: Array<rowObject> } parsed with range:3
   ============================================================ */
function parseAmazon(sheets, homeState) {
  const warnings = [];
  const b2csRows = [];
  const hsnRows = [];

  const b2csData  = sheets['B2C Small']    || [];
  const hsnData   = sheets['HSN Summary']  || [];
  const b2bData   = sheets['B2B']          || [];

  // --- Helper: Amazon's Place Of Supply is "XX-StateName" ---
  // The first 2 characters are directly the GST state code.
  const amazonPOS = (raw) => {
    if (!raw) return null;
    const s = String(raw).trim();
    if (s.length < 2) return null;
    const code = s.substring(0, 2);
    if (/^\d{2}$/.test(code)) return code;
    return null;
  };

  // --- Helper: Amazon Rate is decimal (0.05 = 5%) ---
  const amazonRate = (raw) => round2(numOr0(raw) * 100);

  // --- B2C Small: b2cs rows ---
  let etin = PLATFORM_ETIN.amazon;

  b2csData.forEach(r => {
    const posRaw = r['Place Of Supply'];
    const pos = amazonPOS(posRaw);
    if (!pos) return; // skip blank/summary rows
    const rate = amazonRate(r['Rate']);
    const taxval = numOr0(r['Taxable Value']);
    if (Math.abs(taxval) < 0.005) return; // skip zero-value rows
    // Pick up Amazon ETIN from the file itself if present
    const ecoGstin = r['E-Commerce GSTIN'];
    if (ecoGstin && String(ecoGstin).length === 15) etin = String(ecoGstin).trim();
    b2csRows.push({ pos, rate, taxval });
  });

  // --- HSN Summary: pre-computed IGST/CGST/SGST already split ---
  hsnData.forEach(r => {
    const hsn = String(r['HSN'] ?? '').trim();
    if (!hsn || hsn.toLowerCase() === 'hsn') return; // skip blank/header rows
    const qty   = numOr0(r['Total Quantity']);
    const txval = numOr0(r['Taxable Value']);
    const igst  = numOr0(r['Integrated Tax Amount']);
    const cgst  = numOr0(r['Central Tax Amount']);
    const sgst  = numOr0(r['State/UT Tax Amount']);
    if (Math.abs(txval) < 0.005 && qty === 0) return;
    hsnRows.push({ hsn, qty, taxval: txval, presetTax: { igst, cgst, sgst } });
  });

  // --- B2B (optional, mostly blank) ---
  // Amazon B2B rows have: GSTIN/UIN of Recipient, Place Of Supply, Rate, Taxable Value
  // These go into b2b section — we add them to b2csRows for now since portal
  // b2b handling is separate; mark them so future b2b block can be added.
  const b2bDataRows = b2bData.filter(r => r['GSTIN/UIN of Recipient']);
  if (b2bDataRows.length > 0) {
    warnings.push(`Amazon: ${b2bDataRows.length} B2B row(s) found — B2B section is not yet supported and these rows were skipped. Please file B2B entries manually.`);
  }

  // --- Supeco: derive totals from b2csRows (Amazon has no separate TCS sheet) ---
  // suppval = sum of all taxable values; IGST/CGST/SGST from HSN sheet totals
  const suppval = round2(b2csRows.reduce((s, r) => s + r.taxval, 0));
  const totalIgst = round2(hsnRows.reduce((s, r) => s + (r.presetTax ? r.presetTax.igst : 0), 0));
  const totalCgst = round2(hsnRows.reduce((s, r) => s + (r.presetTax ? r.presetTax.cgst : 0), 0));
  const totalSgst = round2(hsnRows.reduce((s, r) => s + (r.presetTax ? r.presetTax.sgst : 0), 0));

  // --- Doc issue: Amazon doesn't give invoice series — use row count as best estimate ---
  const totalRows = b2csData.filter(r => {
    const pos = amazonPOS(r['Place Of Supply']);
    return pos && Math.abs(numOr0(r['Taxable Value'])) >= 0.005;
  }).length;

  const docIssue = totalRows > 0 ? {
    from: '1',
    to: String(totalRows),
    totnum: totalRows,
    cancel: 0,
    netIssue: totalRows
  } : null;

  return {
    b2csRows,
    hsnRows,
    docIssue,
    supecoMeta: { etin, platform: 'amazon' },
    supecoTotals: { suppval, igst: totalIgst, cgst: totalCgst, sgst: totalSgst, cess: 0 },
    warnings,
    rowCounts: { sales: b2csData.length + b2bData.length, returns: 0 }
  };
}

/* ============================================================
   MERGE STEP — combines any number of platform results into the
   final GSTR1 JSON. This is where the "no duplicate POS+rate" and
   "no duplicate HSN+rate" portal rules are enforced across platforms.
   ============================================================ */
function mergePlatforms(platformResults, meta) {
  const warnings = [];
  const homeState = homeStateFromGSTIN(meta.gstin);

  // ---------- B2CS merge ----------
  const b2csBuckets = new Map(); // `${pos}__${rate}` -> txval
  platformResults.forEach(res => {
    res.b2csRows.forEach(r => {
      const key = `${r.pos}__${r.rate}`;
      b2csBuckets.set(key, round2((b2csBuckets.get(key) || 0) + r.taxval));
    });
  });

  const b2cs = [];
  Array.from(b2csBuckets.entries())
    .map(([key, txval]) => {
      const idx = key.lastIndexOf('__');
      return { pos: key.substring(0, idx), rate: Number(key.substring(idx + 2)), txval };
    })
    .filter(b => Math.abs(b.txval) >= 0.005)
    .sort((a, b) => (a.pos !== b.pos ? a.pos.localeCompare(b.pos) : a.rate - b.rate))
    .forEach(b => {
      const txval = round2(b.txval);
      const totalTax = round2(txval * b.rate / 100);
      const isIntra = homeState && b.pos === homeState;
      b2cs.push({
        sply_ty: isIntra ? 'INTRA' : 'INTER',
        rt: b.rate,
        typ: 'OE',
        pos: b.pos,
        txval: txval,
        iamt: isIntra ? 0 : totalTax,
        samt: isIntra ? round2(totalTax / 2) : 0,
        camt: isIntra ? round2(totalTax / 2) : 0,
        csamt: 0
      });
    });

  // ---------- HSN merge ----------
  // Two shapes can arrive: rate-based rows (Meeso — igst/cgst/sgst derived from
  // rate + home-state check) and preset-tax rows (Flipkart — already split).
  // Both merge into one bucket per HSN code only (portal disallows duplicate
  // HSN+UQC+Rate rows), accumulating qty/txval/tax parts directly.
  const hsnBuckets = new Map(); // hsn -> { qty, taxval, igst, cgst, sgst }

  const ensureHsnBucket = (hsn) => {
    if (!hsnBuckets.has(hsn)) hsnBuckets.set(hsn, { hsn, qty: 0, taxval: 0, igst: 0, cgst: 0, sgst: 0 });
    return hsnBuckets.get(hsn);
  };

  platformResults.forEach(res => {
    res.hsnRows.forEach(r => {
      const bucket = ensureHsnBucket(r.hsn);
      bucket.qty += r.qty;
      bucket.taxval += r.taxval;
      if (r.presetTax) {
        bucket.igst += r.presetTax.igst;
        bucket.cgst += r.presetTax.cgst;
        bucket.sgst += r.presetTax.sgst;
      } else {
        const isIntra = homeState && r.pos === homeState;
        const tax = round2(r.taxval * r.rate / 100);
        if (isIntra) {
          bucket.cgst += tax / 2;
          bucket.sgst += tax / 2;
        } else {
          bucket.igst += tax;
        }
      }
    });
  });

  const hsn_b2c = Array.from(hsnBuckets.values())
    .filter(b => Math.abs(b.taxval) > 0.005 || b.qty !== 0)
    .sort((a, b) => a.hsn.localeCompare(b.hsn))
    .map((b, idx) => ({
      num: idx + 1,
      hsn_sc: b.hsn,
      uqc: 'PCS',
      qty: b.qty,
      rt: inferRateFromTax(b),
      txval: round2(b.taxval),
      iamt: round2(b.igst),
      samt: round2(b.sgst),
      camt: round2(b.cgst),
      csamt: 0
    }));

  // ---------- doc_issue merge: one docs[] entry per platform with a doc series ----------
  const docsArr = [];
  let docNum = 1;
  platformResults.forEach(res => {
    if (res.docIssue) {
      docsArr.push({
        num: docNum++,
        from: res.docIssue.from,
        to: res.docIssue.to,
        totnum: res.docIssue.totnum,
        cancel: res.docIssue.cancel,
        net_issue: res.docIssue.netIssue
      });
    }
  });

  const doc_issue = {
    doc_det: [
      {
        doc_num: 1,
        doc_typ: 'Invoices for outward supply',
        docs: docsArr
      }
    ]
  };

  // ---------- supeco merge: one clttx entry per platform ----------
  const clttx = [];
  platformResults.forEach(res => {
    if (res.supecoTotals) {
      clttx.push({
        etin: res.supecoMeta.etin,
        suppval: res.supecoTotals.suppval,
        igst: res.supecoTotals.igst,
        cgst: res.supecoTotals.cgst,
        sgst: res.supecoTotals.sgst,
        cess: res.supecoTotals.cess || 0,
        flag: 'N'
      });
    } else {
      // Derive totals from this platform's own b2cs rows (Meeso)
      let igst = 0, cgst = 0, sgst = 0;
      const suppval = round2(res.b2csRows.reduce((s, r) => s + r.taxval, 0));
      const buckets = new Map();
      res.b2csRows.forEach(r => {
        const key = `${r.pos}__${r.rate}`;
        buckets.set(key, round2((buckets.get(key) || 0) + r.taxval));
      });
      Array.from(buckets.entries()).forEach(([key, txval]) => {
        const idx = key.lastIndexOf('__');
        const pos = key.substring(0, idx);
        const rate = Number(key.substring(idx + 2));
        if (Math.abs(txval) < 0.005) return;
        const totalTax = round2(txval * rate / 100);
        const isIntra = homeState && pos === homeState;
        if (isIntra) { cgst += totalTax / 2; sgst += totalTax / 2; }
        else { igst += totalTax; }
      });
      clttx.push({
        etin: res.supecoMeta.etin,
        suppval: suppval,
        igst: round2(igst),
        cgst: round2(cgst),
        sgst: round2(sgst),
        cess: 0,
        flag: 'N'
      });
    }
  });

  const supeco = { clttx };

  const json = {
    gstin: meta.gstin,
    fp: meta.fp,
    b2cs: b2cs,
    supeco: supeco,
    hsn: { hsn_b2c: hsn_b2c },
    doc_issue: doc_issue
  };

  const totalSuppval = round2(b2cs.reduce((s, b) => s + b.txval, 0));
  const totalIgst = round2(b2cs.reduce((s, b) => s + b.iamt, 0));
  const totalCgst = round2(b2cs.reduce((s, b) => s + b.camt, 0));
  const totalSgst = round2(b2cs.reduce((s, b) => s + b.samt, 0));
  const totalSalesRows = platformResults.reduce((s, r) => s + r.rowCounts.sales, 0);
  const totalReturnRows = platformResults.reduce((s, r) => s + r.rowCounts.returns, 0);
  const netIssue = docsArr.reduce((s, d) => s + d.net_issue, 0);

  platformResults.forEach(res => warnings.push(...res.warnings));

  const stats = {
    totalSalesRows,
    totalReturnRows,
    netIssue,
    totalTaxableValue: totalSuppval,
    totalIgst,
    totalCgst,
    totalSgst,
    totalTax: round2(totalIgst + totalCgst + totalSgst),
    statesCount: b2cs.length,
    hsnCount: hsn_b2c.length
  };

  return { json, warnings, stats };
}

function inferRateFromTax(b) {
  if (Math.abs(b.taxval) < 0.005) return 0;
  const totalTax = b.igst + b.cgst + b.sgst;
  const rate = (totalTax / b.taxval) * 100;
  // Snap to the nearest common GST slab to avoid ugly floating artifacts like 4.97%
  const slabs = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 12, 18, 28];
  let closest = slabs[0];
  let minDiff = Math.abs(rate - slabs[0]);
  slabs.forEach(s => {
    const diff = Math.abs(rate - s);
    if (diff < minDiff) { minDiff = diff; closest = s; }
  });
  return closest;
}

/* ============================================================
   PUBLIC API
   ============================================================ */

// Legacy single-platform (Meeso-only) entry point, kept for backward compatibility.
function convertToGSTR1(salesRows, returnRows, meta) {
  const meeso = parseMeeso(salesRows, returnRows);
  return mergePlatforms([meeso], meta);
}

// New multi-platform entry point.
// platformsInput: { meeso?: {salesRows, returnRows}, flipkart?: {sheets}, amazon?: {sheets} }
function convertMultiPlatform(platformsInput, meta) {
  const homeState = homeStateFromGSTIN(meta.gstin);
  const results = [];

  if (platformsInput.meeso) {
    results.push(parseMeeso(platformsInput.meeso.salesRows || [], platformsInput.meeso.returnRows || []));
  }
  if (platformsInput.flipkart) {
    results.push(parseFlipkart(platformsInput.flipkart.sheets || {}, homeState));
  }
  if (platformsInput.amazon) {
    results.push(parseAmazon(platformsInput.amazon.sheets || {}, homeState));
  }

  if (results.length === 0) {
    throw new Error('No platform data provided');
  }

  return mergePlatforms(results, meta);
}

// Quarter -> month numbers (GST fiscal quarters: Apr-Jun = Q1 ... Jan-Mar = Q4)
const QUARTER_MONTHS = {
  Q1: [4, 5, 6],
  Q2: [7, 8, 9],
  Q3: [10, 11, 12],
  Q4: [1, 2, 3]
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    convertToGSTR1,
    convertMultiPlatform,
    parseMeeso,
    parseFlipkart,
    parseAmazon,
    mergePlatforms,
    STATE_CODE_MAP,
    resolvePOS,
    homeStateFromGSTIN,
    QUARTER_MONTHS,
    round2,
    PLATFORM_ETIN
  };
}
