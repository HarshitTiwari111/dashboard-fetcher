// ✅ puppeteer-core nahi, puppeteer use karo
const puppeteer = require('puppeteer');
const fs = require('fs');

const dashboardKey  = process.argv[2];
const site          = process.argv[3];
const monthArg      = process.argv[4];
const reportTypeArg = process.argv[5] || "General";

function resolveMonthArg(raw) {
    const norm = (raw || '').trim().toLowerCase();
    if (norm === 'current month' || norm === 'this month') {
        const now = new Date();
        const monthNames = ["January","February","March","April","May","June",
                            "July","August","September","October","November","December"];
        return `${monthNames[now.getMonth()]} ${now.getFullYear()}`;
    }
    return raw;
}
const resolvedMonth = resolveMonthArg(monthArg);

const response = {
    success: false,
    dashboard: dashboardKey,
    site: site,
    month: resolvedMonth,
    report_type: reportTypeArg,
    data: [],
    logs: []
};

let browser = null;
let page    = null;

function logStep(stepNum, description, isSuccess) {
    response.logs.push(`[STEP ${stepNum}] ${description} — ${isSuccess ? "SUCCESS" : "FAILED"}`);
}
function finish(success) {
    response.success = success;
    console.log(JSON.stringify(response));
    process.exit(0);
}

// ─────────────────────────────────────────────
// REWARDS AFFILIATES helpers
// ─────────────────────────────────────────────
async function findAndFill(targetPage, fieldType, value, logs) {
    const selectors = fieldType === 'username'
        ? ['#ctl00_ContentPlaceHolder1_txtUsername','input[id*="Username" i]','input[name*="Username" i]',
           'input[id*="user" i]','input[name*="user" i]',
           'input[type="text"]:not([id*="pass" i]):not([name*="pass" i])','input[type="email"]']
        : ['#ctl00_ContentPlaceHolder1_txtPassword','input[id*="Password" i]',
           'input[name*="Password" i]','input[type="password"]'];
    for (const sel of selectors) {
        try {
            const el = await targetPage.$(sel);
            if (el) {
                const ok = await targetPage.evaluate(s => {
                    const e = document.querySelector(s);
                    if (!e) return false;
                    const st = window.getComputedStyle(e);
                    return st.display !== 'none' && st.visibility !== 'hidden' && e.offsetParent !== null;
                }, sel);
                if (ok) {
                    await targetPage.evaluate((s, v) => {
                        const i = document.querySelector(s);
                        i.focus(); i.value = v;
                        i.dispatchEvent(new Event('input',  { bubbles: true }));
                        i.dispatchEvent(new Event('change', { bubbles: true }));
                    }, sel, value);
                    logs.push(`[DEBUG] ${fieldType} filled via '${sel}'`);
                    return sel;
                }
            }
        } catch(_) {}
    }
    logs.push(`[DEBUG] WARNING: ${fieldType} NOT found`);
    return null;
}

async function findAndClickSubmit(targetPage, logs) {
    for (const sel of [
        '#ctl00_ContentPlaceHolder1_btnLogin','input[id*="Login" i][type="submit"]',
        'button[id*="Login" i]','input[value*="Log" i][type="submit"]',
        'button[type="submit"]','input[type="submit"]'
    ]) {
        try {
            const el = await targetPage.$(sel);
            if (el) { logs.push(`[DEBUG] Submit: '${sel}'`); return sel; }
        } catch(_) {}
    }
    return null;
}

async function rewardsApplyFilters(page, site, resolvedMonth, logs) {
    logs.push(`[DEBUG] rewardsApplyFilters: site="${site}" month="${resolvedMonth}"`);

    const allSelects = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('select')).map(s => ({
            id: s.id || '', name: s.name || '',
            options: Array.from(s.options).map(o => ({ val: o.value, text: o.text.trim() }))
        }));
    });
    logs.push(`[DEBUG] All selects (${allSelects.length}): ${JSON.stringify(allSelects)}`);

    const siteResult = await page.evaluate((siteVal) => {
        const norm = s => (s || '').trim().toLowerCase();
        const nSite = norm(siteVal);
        const selects = Array.from(document.querySelectorAll('select'));
        let dd = selects.find(s =>
            ['site','brand','casino','property','merchant','website','operator','product']
                .some(kw => norm(s.id).includes(kw) || norm(s.name).includes(kw))
        );
        if (!dd) dd = selects.find(s => Array.from(s.options).some(o => norm(o.text).includes(nSite) || nSite.includes(norm(o.text))));
        if (!dd) dd = selects.find(s => {
            const opts = Array.from(s.options).map(o => norm(o.text));
            const hasDate = opts.some(o => /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{4})\b/.test(o));
            return s.options.length > 1 && !hasDate;
        });
        if (!dd) return `SITE_SELECT_NOT_FOUND`;
        let opt = Array.from(dd.options).find(o => norm(o.text) === nSite);
        if (!opt) opt = Array.from(dd.options).find(o => norm(o.text).includes(nSite) || nSite.includes(norm(o.text)));
        if (!opt) opt = Array.from(dd.options).find(o => {
            const words = nSite.split(/\s+/);
            return words.some(w => w.length > 3 && norm(o.text).includes(w));
        });
        if (!opt) return `SITE_OPTION_NOT_FOUND: "${siteVal}"`;
        dd.value = opt.value;
        dd.dispatchEvent(new Event('change', { bubbles: true }));
        return `SITE_OK: "${opt.text}"`;
    }, site);
    logs.push(`[DEBUG] Site result: ${siteResult}`);
    await new Promise(r => setTimeout(r, 800));

    const parts = resolvedMonth.split(' ');
    const mName = parts[0]; const mYear = parts[1];

    const dateResult = await page.evaluate((mName, mYear, fullMonth) => {
        const norm = s => (s || '').trim().toLowerCase();
        const selects = Array.from(document.querySelectorAll('select'));
        let dd = selects.find(s => Array.from(s.options).some(o => /[a-z]+ \d{4}/i.test(o.text.trim())));
        if (dd) {
            let opt = Array.from(dd.options).find(o => norm(o.text) === norm(fullMonth));
            if (!opt) opt = Array.from(dd.options).find(o => norm(o.text).includes(norm(mName)) && o.text.includes(mYear));
            if (opt) { dd.value = opt.value; dd.dispatchEvent(new Event('change', { bubbles: true })); return `COMBINED_DATE_OK: "${opt.text}"`; }
            return `COMBINED_DATE_NO_OPT`;
        }
        const mDd = selects.find(s => norm(s.id).includes('month') || norm(s.name).includes('month') ||
            Array.from(s.options).some(o => ['january','february','march','april','may','june','july','august','september','october','november','december'].includes(norm(o.text))));
        const yDd = selects.find(s => norm(s.id).includes('year') || norm(s.name).includes('year') ||
            Array.from(s.options).some(o => /^\d{4}$/.test(o.text.trim())));
        let mResult = 'MONTH_SEL_NOT_FOUND', yResult = 'YEAR_SEL_NOT_FOUND';
        if (mDd) { const mOpt = Array.from(mDd.options).find(o => norm(o.text).includes(norm(mName))); if (mOpt) { mDd.value = mOpt.value; mDd.dispatchEvent(new Event('change', { bubbles: true })); mResult = `MONTH_OK:${mOpt.text}`; } }
        if (yDd) { const yOpt = Array.from(yDd.options).find(o => o.text.trim() === mYear); if (yOpt) { yDd.value = yOpt.value; yDd.dispatchEvent(new Event('change', { bubbles: true })); yResult = `YEAR_OK:${yOpt.text}`; } }
        return `${mResult} | ${yResult}`;
    }, mName, mYear, resolvedMonth);
    logs.push(`[DEBUG] Date result: ${dateResult}`);
    await new Promise(r => setTimeout(r, 500));

    const goBtns = ['input[id*="Go" i][type="submit"]','input[value="Go"][type="submit"]',
        'input[value="Search"][type="submit"]','button[id*="Go" i]','input[type="submit"]','button[type="submit"]'];
    let btnClicked = false;
    for (const sel of goBtns) {
        const btn = await page.$(sel);
        if (btn) {
            logs.push(`[DEBUG] Clicking go btn: ${sel}`);
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null),
                btn.click()
            ]);
            await new Promise(r => setTimeout(r, 5000));
            btnClicked = true;
            break;
        }
    }
    logs.push(`[DEBUG] Go btn clicked: ${btnClicked}`);
    return { siteResult, dateResult, btnClicked };
}

function filterRowsUpToToday(dataMatrix) {
    if (!dataMatrix || dataMatrix.length < 2) return dataMatrix;
    const today = new Date(); today.setHours(23, 59, 59, 999);
    const header = dataMatrix[0];
    const rows = dataMatrix.slice(1);
    const filtered = rows.filter(row => {
        const dateStr = String(row[0] || '').trim();
        if (!dateStr) return false;
        if (/^(total|totals|grand total)$/i.test(dateStr)) return true;
        const parsed = new Date(dateStr);
        if (!isNaN(parsed.getTime())) return parsed <= today;
        const m = dateStr.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
        if (m) { const d = new Date(`${m[2]} ${m[1]}, ${m[3]}`); return !isNaN(d.getTime()) ? d <= today : true; }
        return true;
    });
    return [header, ...filtered];
}

// ─────────────────────────────────────────────
// DATE FILTER for RO_AFFILIATE
// ─────────────────────────────────────────────
async function applyDateFilter(page, monthArg, logs) {
    logs.push(`[DEBUG] applyDateFilter: "${monthArg}"`);
    try {
        await new Promise(r => setTimeout(r, 3000));

        // ✅ FIX: Date button dhundo — calendar icon wala button
        const openResult = await page.evaluate(() => {
            // Method 1: Button with date range text
            const allBtns = Array.from(document.querySelectorAll('button'));
            let dateBtn = allBtns.find(el => {
                const t = (el.innerText || '').trim().toLowerCase();
                return (t.includes('this year') || t.includes('today') || 
                        t.includes('this month') || t.includes('last month') ||
                        t.includes('yesterday') || /\d{2}\/\d{2}\/\d{4}/.test(t)) && t.length < 80;
            });
            // Method 2: Button with SVG calendar icon
            if (!dateBtn) {
                dateBtn = allBtns.find(el => {
                    const hasSvg = el.querySelector('svg') !== null;
                    const t = (el.innerText || '').trim().toLowerCase();
                    return hasSvg && (t.includes('year') || t.includes('month') || t.includes('today') || t === '');
                });
            }
            // Method 3: Any popover trigger near top
            if (!dateBtn) {
                dateBtn = document.querySelector('[data-scope="popover"] button, [aria-haspopup="dialog"] button');
            }
            if (dateBtn) { dateBtn.click(); return `OPENED: "${dateBtn.innerText.trim()}"`; }
            return 'NO_DATE_OPENER_FOUND';
        });
        logs.push(`[DEBUG] Open date picker: ${openResult}`);
        await new Promise(r => setTimeout(r, 2000));
        const res = await page.evaluate((mArg) => {
            const norm = s => (s || '').trim().toLowerCase();
            const all = Array.from(document.querySelectorAll(
                'li, [role="option"], [role="menuitem"], div[class*="option"], ' +
                'div[class*="item"], div[class*="preset"], div[class*="period"], button, span'
            ));
            let tgt = all.find(e => norm(e.innerText) === norm(mArg));
            if (!tgt) tgt = all.find(e => { const t = norm(e.innerText); return t.includes(norm(mArg)) && t.length < 40; });
            if (!tgt && norm(mArg) === 'current month') tgt = all.find(e => norm(e.innerText) === 'this month');
            if (!tgt) {
                const parts = mArg.split(' ');
                if (parts.length === 2 && /\d{4}/.test(parts[1])) {
                    const now = new Date();
                    const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
                    const curMonthStr = `${monthNames[now.getMonth()]} ${now.getFullYear()}`;
                    if (mArg === curMonthStr) {
                        tgt = all.find(e => { const t = norm(e.innerText); return t === 'this month' || t === 'current month'; });
                    }
                }
            }
            if (tgt) { tgt.click(); return `CLICKED: "${tgt.innerText.trim()}"`; }
            const visible = all.map(e => (e.innerText || '').trim()).filter(t => t && t.length < 50).slice(0, 20);
            return 'NOT_FOUND: ' + visible.join(' | ');
        }, monthArg);
        logs.push(`[DEBUG] Date option: ${res}`);
        await new Promise(r => setTimeout(r, 1000));

        const applyResult = await page.evaluate(() => {
            const b = Array.from(document.querySelectorAll('button'))
                .find(b => ['apply','ok','confirm','set','done'].includes((b.innerText || '').trim().toLowerCase()));
            if (b) { b.click(); return `APPLIED: "${b.innerText.trim()}"`; }
            return 'NO_APPLY_BTN';
        });
        logs.push(`[DEBUG] Apply btn: ${applyResult}`);
        await new Promise(r => setTimeout(r, 2000));
        return !res.startsWith('NOT_FOUND');
    } catch(e) {
        logs.push(`[DEBUG] applyDateFilter error: ${e.message}`);
        return false;
    }
}

// ─────────────────────────────────────────────
// SPLIT BY
// ─────────────────────────────────────────────
async function applySplitBy(page, monthArg, logs) {
    const isYear = /(this year|last year|year)/i.test(monthArg || '');
    const wantedSplit = isYear ? 'month' : 'day';
    logs.push(`[DEBUG] applySplitBy want="${wantedSplit}"`);
    try {
        const currentState = await page.evaluate(() => {
            const norm = t => (t || '').trim().toLowerCase();
            const all = Array.from(document.querySelectorAll('*'));
            const splitEl = all.find(el => {
                const t = norm(el.innerText || '');
                return t.startsWith('split by') && t.length < 30 && el.children.length === 0;
            });
            return splitEl ? splitEl.innerText.trim() : null;
        });
        logs.push(`[DEBUG] Current split state: "${currentState}"`);
        if (currentState && currentState.toLowerCase().includes(wantedSplit)) {
            logs.push(`[DEBUG] Split already correct, skipping`);
            return;
        }
        await page.keyboard.press('Escape');
        await new Promise(r => setTimeout(r, 500));

        const splitBtnInfo = await page.evaluate(() => {
            const norm = t => (t || '').trim().toLowerCase();
            const allEls = Array.from(document.querySelectorAll('button, [role="button"], div, span'));
            const candidates = allEls.filter(el => {
                const t = norm(el.innerText || '');
                return t.startsWith('split by') && t.length < 25;
            });
            if (candidates.length === 0) return { found: false };
            let best = candidates[0];
            for (const c of candidates) { if (c.children.length < best.children.length) best = c; }
            const rect = best.getBoundingClientRect();
            return { found: true, text: best.innerText.trim(), tag: best.tagName,
                     x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        });
        logs.push(`[DEBUG] Split btn info: ${JSON.stringify(splitBtnInfo)}`);
        if (!splitBtnInfo.found) { logs.push(`[DEBUG] Split By button not found`); return; }

        await page.mouse.click(splitBtnInfo.x, splitBtnInfo.y);
        logs.push(`[DEBUG] Clicked split-by at (${Math.round(splitBtnInfo.x)}, ${Math.round(splitBtnInfo.y)})`);
        await new Promise(r => setTimeout(r, 1500));

        const pickResult = await page.evaluate((wanted) => {
            const norm = t => (t || '').trim().toLowerCase();
            const allEls = Array.from(document.querySelectorAll(
                'li, [role="option"], [role="menuitem"], div[class*="option"], div[class*="item"], ul > li, button, span'
            ));
            let tgt = allEls.find(el => norm(el.innerText) === wanted);
            if (!tgt) tgt = allEls.find(el => { const t = norm(el.innerText); return t === `split by ${wanted}` || t.endsWith(wanted); });
            if (!tgt) tgt = allEls.find(el => { const t = norm(el.innerText); return t.includes(wanted) && t.length < 20; });
            if (tgt) {
                const rect = tgt.getBoundingClientRect();
                return { found: true, text: tgt.innerText.trim(), x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
            }
            return { found: false };
        }, wantedSplit);
        logs.push(`[DEBUG] Pick option info: ${JSON.stringify(pickResult)}`);
        if (pickResult.found) {
            await page.mouse.click(pickResult.x, pickResult.y);
            logs.push(`[DEBUG] Clicked "${pickResult.text}"`);
        }
        await new Promise(r => setTimeout(r, 1200));

        const finalState = await page.evaluate(() => {
            const norm = t => (t || '').trim().toLowerCase();
            const all = Array.from(document.querySelectorAll('*'));
            const el = all.find(e => { const t = norm(e.innerText || ''); return t.startsWith('split by') && t.length < 25 && e.children.length === 0; });
            return el ? el.innerText.trim() : 'unknown';
        });
        logs.push(`[DEBUG] Final split state: "${finalState}"`);
    } catch(e) {
        logs.push(`[DEBUG] applySplitBy error: ${e.message}`);
    }
}

// ─────────────────────────────────────────────
// TABLE EXTRACTOR
// ─────────────────────────────────────────────
async function extractReportTable(page, logs) {
    logs.push(`[DEBUG] extractReportTable starting...`);

    const pageInfo = await page.evaluate(() => {
        return {
            url: window.location.href,
            roleGrid: document.querySelectorAll('[role="grid"]').length,
            roleTable: document.querySelectorAll('[role="table"]').length,
            tables: document.querySelectorAll('table').length,
            roleRows: document.querySelectorAll('[role="row"]').length,
            trRows: document.querySelectorAll('tr').length,
            tdCells: document.querySelectorAll('td').length,
            sampleTd: Array.from(document.querySelectorAll('td')).slice(0,8).map(el => (el.innerText||'').trim())
        };
    });
    logs.push(`[DEBUG] Page info: ${JSON.stringify(pageInfo)}`);

    await page.evaluate(() => window.scrollBy(0, 400));
    await new Promise(r => setTimeout(r, 1000));
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise(r => setTimeout(r, 500));

    const tableData = await page.evaluate(() => {
        function safeClass(el) {
            try {
                const cn = el.className;
                if (!cn) return '';
                if (typeof cn === 'string') return cn.toLowerCase();
                if (cn.baseVal !== undefined) return String(cn.baseVal).toLowerCase();
                return String(cn).toLowerCase();
            } catch(e) { return ''; }
        }

        const grid = document.querySelector('[role="grid"], [role="table"]');
        if (grid) {
            const rows = Array.from(grid.querySelectorAll('[role="row"]'));
            const matrix = rows.map(row => {
                const cells = Array.from(row.querySelectorAll('[role="columnheader"], [role="cell"], [role="gridcell"]'));
                return cells.map(c => (c.innerText || '').trim().replace(/\n/g, ' '));
            }).filter(r => r.length > 0 && r.some(c => c !== ''));
            if (matrix.length > 1) return { method: 'role-grid', data: matrix };
        }

        const tables = Array.from(document.querySelectorAll('table'));
        if (tables.length > 0) {
            let bestTable = null, bestScore = 0;
            tables.forEach(t => {
                const trows = t.querySelectorAll('tr');
                const cols = trows.length > 0
                    ? Math.max(...Array.from(trows).map(r => r.querySelectorAll('td,th').length))
                    : 0;
                const score = trows.length * cols;
                if (score > bestScore) { bestScore = score; bestTable = t; }
            });
            if (bestTable) {
                const matrix = [];
                bestTable.querySelectorAll('tr').forEach(row => {
                    const cells = Array.from(row.querySelectorAll('td, th'));
                    if (!cells.length) return;
                    const rowData = cells.map(c => (c.innerText || '').trim().replace(/\n/g, ' '));
                    if (rowData.some(c => c !== '')) matrix.push(rowData);
                });
                if (matrix.length > 1) return { method: 'table-element', data: matrix };
            }
        }

        const knownHeaders = ['month','day','date','clicks','uniq clicks','reg. count','ftd count',
            'deposits','turnovers','ngr','ttl reward','ttl paid','ttl balance',
            'registrations','bettors','revenue','commission','net revenue',
            'sub-affiliates','players','new players','active players','impressions','visits'];
        const allEls = Array.from(document.querySelectorAll('*'));
        let headerEl = null;
        for (const el of allEls) {
            if (el.children.length > 0) continue;
            const t = (el.innerText || '').trim().toLowerCase();
            if (knownHeaders.includes(t)) { headerEl = el; break; }
        }
        if (headerEl) {
            const headerRow = headerEl.closest('[role="row"]') || headerEl.parentElement;
            if (headerRow) {
                const tableContainer = headerRow.closest('[role="grid"]') ||
                    headerRow.closest('[role="table"]') || headerRow.closest('table') || headerRow.parentElement;
                if (tableContainer) {
                    const rows = Array.from(tableContainer.querySelectorAll('[role="row"], tr'));
                    const matrix = rows.map(row => {
                        const cells = Array.from(row.querySelectorAll('[role="columnheader"], [role="cell"], [role="gridcell"], td, th'));
                        return cells.map(c => (c.innerText || '').trim().replace(/\n/g, ' '));
                    }).filter(r => r.length > 1 && r.some(c => c !== ''));
                    if (matrix.length > 1) return { method: 'anchor-header', data: matrix };
                }
            }
        }

        const rowsMap = new Map();
        Array.from(document.querySelectorAll('*')).forEach(el => {
            if (el.children.length !== 0) return;
            const t = (el.innerText || '').trim();
            if (!t || t.length > 60) return;
            try {
                const rect = el.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0 || rect.left <= 280 || rect.top <= 380) return;
                const y = Math.round(rect.top / 10) * 10;
                if (!rowsMap.has(y)) rowsMap.set(y, []);
                rowsMap.get(y).push({ text: t, x: rect.left });
            } catch(e) {}
        });
        const sortedY = Array.from(rowsMap.keys()).sort((a, b) => a - b);
        const matrix2 = [];
        sortedY.forEach(y => {
            const items = rowsMap.get(y);
            if (items.length < 2) return;
            items.sort((a, b) => a.x - b.x);
            const row = items.map(i => i.text);
            const isPagination = row.some(c => /page \d+ of/i.test(c) || /show rows/i.test(c));
            if (!isPagination) matrix2.push(row);
        });
        if (matrix2.length > 1) return { method: 'positional', data: matrix2 };

        const allText = Array.from(document.querySelectorAll('td, [role="cell"], [role="gridcell"]'))
            .map(el => (el.innerText || '').trim()).filter(t => t).slice(0, 30);
        return { method: 'none', data: [], allText };
    });

    logs.push(`[DEBUG] Extraction method: ${tableData.method}, rows: ${tableData.data.length}`);
    if (tableData.method === 'none' && tableData.allText) {
        logs.push(`[DEBUG] Cell dump: ${(tableData.allText||[]).join(' | ')}`);
    }
    if (tableData.data.length > 0) {
        logs.push(`[DEBUG] Header row: ${JSON.stringify(tableData.data[0])}`);
        if (tableData.data.length > 1) logs.push(`[DEBUG] Data row 1: ${JSON.stringify(tableData.data[1])}`);
    }

    const matrix = tableData.data;
    if (matrix.length > 0) {
        const maxCols = Math.max(...matrix.map(r => r.length));
        return matrix.map(row => { const r = [...row]; while (r.length < maxCols) r.push(''); return r; });
    }
    return [];
}

// ─────────────────────────────────────────────
// RO_AFFILIATE — General / Finance
// ─────────────────────────────────────────────
async function roAffiliateGeneralFinance(page, monthArg, logs) {
    logs.push(`[DEBUG] Flow: GENERAL/FINANCE`);

    await applySplitBy(page, monthArg, logs);
    await new Promise(r => setTimeout(r, 1000));

    logs.push(`[DEBUG] Clicking "Generate report"...`);
    const clicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => (b.innerText || '').trim().toLowerCase() === 'generate report');
        if (btn) { btn.click(); return true; }
        const partial = btns.find(b => (b.innerText || '').trim().toLowerCase().includes('generate'));
        if (partial) { partial.click(); return 'partial'; }
        return false;
    });
    logs.push(`[DEBUG] Generate report clicked: ${clicked}`);

    logs.push(`[DEBUG] Polling for data (up to 35s)...`);
    const pollStart = Date.now();
    let rows = [];

    while (Date.now() - pollStart < 35000) {
        await new Promise(r => setTimeout(r, 3000));

        const tableStatus = await page.evaluate(() => {
            const grid = document.querySelector('[role="grid"], [role="table"]');
            if (grid) {
                const dataRows = grid.querySelectorAll('[role="row"]');
                if (dataRows.length >= 2) return { found: true, method: 'role-grid', count: dataRows.length };
            }
            const tables = Array.from(document.querySelectorAll('table'));
            for (const t of tables) {
                const trCount = t.querySelectorAll('tr').length;
                const tdCount = t.querySelectorAll('td').length;
                if (trCount >= 2 && tdCount >= 1) return { found: true, method: 'table', count: trCount };
            }
            const isLoading = Array.from(document.querySelectorAll('[class*="loading"], [class*="spinner"], [class*="skeleton"]')).some(el => {
                try { return el.getBoundingClientRect().width > 0; } catch(e) { return false; }
            });
            return { found: false, loading: isLoading };
        });

        logs.push(`[DEBUG] Data check at ${Math.round((Date.now()-pollStart)/1000)}s: ${JSON.stringify(tableStatus)}`);

        if (tableStatus.found) {
            rows = await extractReportTable(page, logs);
            if (rows.length > 1) {
                logs.push(`[DEBUG] Got ${rows.length} rows, done polling`);
                break;
            }
            logs.push(`[DEBUG] Table found but extract returned ${rows.length} rows, retrying...`);
        }
    }

    if (!rows || rows.length <= 1) {
        logs.push(`[DEBUG] Final extraction attempt after 5s...`);
        await new Promise(r => setTimeout(r, 5000));
        rows = await extractReportTable(page, logs);
    }

    return rows;
}

// ─────────────────────────────────────────────
// CUSTOMERS TABLE EXTRACTOR
// ─────────────────────────────────────────────
async function extractCustomersTable(page, logs) {
    logs.push(`[DEBUG] extractCustomersTable starting...`);
    const customerHeaders = ['customer id','gender','geo','signup date','company','affiliate',
        'id','email','username','name','status','country','registered'];

    const result = await page.evaluate((custHeaders) => {
        const grids = Array.from(document.querySelectorAll('[role="grid"], [role="table"]'));
        for (const grid of grids) {
            const rows = Array.from(grid.querySelectorAll('[role="row"]'));
            if (rows.length < 2) continue;
            const matrix = rows.map(row => {
                const cells = Array.from(row.querySelectorAll('[role="columnheader"], [role="cell"], [role="gridcell"]'));
                return cells.map(c => (c.innerText || c.textContent || '').trim().replace(/\n/g, ' '));
            }).filter(r => r.length > 0 && r.some(c => c !== ''));
            if (matrix.length >= 1) return { method: 'role-grid', data: matrix };
        }
        const tables = Array.from(document.querySelectorAll('table'));
        if (tables.length) {
            let best = null, bestScore = 0;
            tables.forEach(t => {
                const s = t.querySelectorAll('tr').length * Math.max(...Array.from(t.querySelectorAll('tr')).map(r => r.querySelectorAll('td,th').length), 1);
                if (s > bestScore) { bestScore = s; best = t; }
            });
            if (best) {
                const mat = [];
                best.querySelectorAll('tr').forEach(row => {
                    const cells = Array.from(row.querySelectorAll('td,th'));
                    if (!cells.length) return;
                    const r = cells.map(c => (c.innerText || '').trim().replace(/\n/g,' '));
                    if (r.some(c => c)) mat.push(r);
                });
                if (mat.length > 1) return { method: 'table', data: mat };
            }
        }
        const norm = t => (t || '').trim().toLowerCase();
        const allEls = Array.from(document.querySelectorAll('*'));
        let anchor = null;
        for (const el of allEls) {
            if (el.children.length > 0) continue;
            const t = norm(el.innerText || el.textContent);
            if (custHeaders.includes(t)) { anchor = el; break; }
        }
        if (anchor) {
            const headerRow = anchor.closest('[role="row"]') || anchor.parentElement;
            if (headerRow) {
                const container = headerRow.closest('[role="grid"]') || headerRow.closest('[role="table"]') ||
                    headerRow.closest('table') || headerRow.parentElement?.parentElement || headerRow.parentElement;
                if (container) {
                    const rows = Array.from(container.querySelectorAll('[role="row"], tr'));
                    const mat = rows.map(row => {
                        const cells = Array.from(row.querySelectorAll('[role="columnheader"],[role="cell"],[role="gridcell"],td,th'));
                        return cells.map(c => (c.innerText || '').trim().replace(/\n/g,' '));
                    }).filter(r => r.length > 0 && r.some(c => c !== ''));
                    if (mat.length > 1) return { method: 'anchor', data: mat };
                }
            }
        }
        const rowsMap = new Map();
        Array.from(document.querySelectorAll('*')).forEach(el => {
            if (el.children.length !== 0) return;
            const t = (el.innerText || el.textContent || '').trim();
            if (!t || t.length > 80) return;
            try {
                const rect = el.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0 || rect.left <= 280 || rect.top <= 250) return;
                const y = Math.round(rect.top / 8) * 8;
                if (!rowsMap.has(y)) rowsMap.set(y, []);
                rowsMap.get(y).push({ text: t, x: rect.left });
            } catch(e) {}
        });
        const sortedY = Array.from(rowsMap.keys()).sort((a,b) => a-b);
        const mat5 = [];
        sortedY.forEach(y => {
            const items = rowsMap.get(y);
            if (items.length < 2) return;
            items.sort((a,b) => a.x - b.x);
            mat5.push(items.map(i => i.text));
        });
        if (mat5.length > 1) return { method: 'positional', data: mat5 };
        return { method: 'none', data: [] };
    }, customerHeaders);

    logs.push(`[DEBUG] Customer extract: ${result.method}, rows: ${result.data.length}`);
    if (result.data.length > 0) logs.push(`[DEBUG] First row: ${JSON.stringify(result.data[0])}`);
    return result.data;
}

// ─────────────────────────────────────────────
// CUSTOMERS FLOW — FIXED: login wait 15s → 5s
// ─────────────────────────────────────────────
async function roAffiliateCustomers(page, monthArg, logs) {
    logs.push(`[DEBUG] Flow: CUSTOMERS`);

    // Generate report click karo — date filter already main flow mein ho chuka hai
    const clicked = await page.evaluate(() => {
        const allBtns = Array.from(document.querySelectorAll('button'));
        let btn = allBtns.find(b => (b.innerText || '').trim().toLowerCase() === 'generate report');
        if (!btn) btn = allBtns.find(b => (b.innerText || '').trim().toLowerCase().includes('generate'));
        if (!btn) btn = allBtns.find(b => b.querySelector('svg') && (b.innerText || '').trim() === '');
        if (btn) { btn.click(); return true; }
        return false;
    });
    logs.push(`[DEBUG] Generate report clicked: ${clicked}`);

    const start = Date.now();
    let rows = [];
    while (Date.now() - start < 30000) {
        await new Promise(r => setTimeout(r, 3000));
        rows = await extractCustomersTable(page, logs);
        if (rows && rows.length > 1) { logs.push(`[DEBUG] Customers table: ${rows.length} rows`); break; }
        logs.push(`[DEBUG] Still waiting... ${Math.round((Date.now()-start)/1000)}s`);
    }
    if (!rows || rows.length <= 1) {
        await new Promise(r => setTimeout(r, 5000));
        rows = await extractCustomersTable(page, logs);
    }
    return rows;
}

// ─────────────────────────────────────────────
// REWARDS AFFILIATES TABLE FETCHER
// ─────────────────────────────────────────────
async function rewardsAffiliateFetchTable(page, logs) {
    logs.push(`[DEBUG] Polling rewards_affiliates table...`);
    const pollStart = Date.now();
    while (Date.now() - pollStart < 35000) {
        await new Promise(r => setTimeout(r, 2500));
        const found = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('table')).some(t => {
                const ths = Array.from(t.querySelectorAll('th')).map(th => (th.innerText || '').trim().toLowerCase());
                return ths.includes('date') && ths.includes('clicks');
            });
        });
        if (found) { logs.push(`[DEBUG] Data table found!`); break; }
        logs.push(`[DEBUG] Waiting... ${Math.round((Date.now()-pollStart)/1000)}s`);
    }

    const raw = await page.evaluate(() => {
        const norm = s => (s || '').trim().toLowerCase();
        const tables = Array.from(document.querySelectorAll('table'));
        let dataTable = null;
        for (const t of tables) {
            const ths = Array.from(t.querySelectorAll('th')).map(th => norm(th.innerText));
            if (ths.includes('date') && ths.includes('clicks')) { dataTable = t; break; }
        }
        if (!dataTable) {
            for (const t of tables) {
                for (const tr of Array.from(t.querySelectorAll('tr'))) {
                    const cells = Array.from(tr.querySelectorAll('th,td')).map(c => norm(c.innerText));
                    if (cells.includes('date') && cells.includes('clicks')) { dataTable = t; break; }
                }
                if (dataTable) break;
            }
        }
        if (!dataTable) {
            let best = null, bestRows = 0;
            tables.forEach(t => { const rc = t.querySelectorAll('tr').length; if (rc > bestRows) { bestRows = rc; best = t; } });
            if (best && best.querySelectorAll('tr').length > 8) dataTable = best;
        }
        if (!dataTable) return { found: false, headers: [], rows: [] };

        let headers = [];
        const headerTr = Array.from(dataTable.querySelectorAll('tr')).find(tr => tr.querySelectorAll('th').length >= 3);
        if (headerTr) headers = Array.from(headerTr.querySelectorAll('th,td')).map(c => (c.innerText || '').trim());

        const rows = [];
        let domTotalRow = null;
        dataTable.querySelectorAll('tr').forEach(tr => {
            if (tr.querySelectorAll('td').length === 0) return;
            const row = Array.from(tr.querySelectorAll('td')).map(td => (td.innerText || td.textContent || '').trim());
            if (row.every(c => c === '')) return;
            const firstCell = (row[0] || '').trim().toLowerCase();
            const inTfoot = tr.closest('tfoot') !== null;
            let trClass = '';
            try { const cn = tr.className; trClass = (typeof cn === 'string' ? cn : (cn && cn.baseVal) ? cn.baseVal : String(cn || '')).toLowerCase(); } catch(e) {}
            const isTotal = inTfoot || trClass.includes('total') || trClass.includes('summary') || trClass.includes('footer') ||
                firstCell === 'total' || firstCell === 'totals' || firstCell === 'grand total';
            if (isTotal) {
                const nonZero = row.filter(c => c && c !== '0' && c !== '-').length;
                const prevNZ = domTotalRow ? domTotalRow.filter(c => c && c !== '0' && c !== '-').length : -1;
                if (nonZero > prevNZ) domTotalRow = row;
            } else { rows.push(row); }
        });
        if (!domTotalRow) {
            const tfoot = dataTable.querySelector('tfoot');
            if (tfoot) {
                const cells = Array.from(tfoot.querySelectorAll('td, th'));
                if (cells.length > 0) domTotalRow = cells.map(td => (td.innerText || td.textContent || '').trim());
            }
        }
        return { found: true, headers, rows, totalRow: domTotalRow };
    });

    logs.push(`[DEBUG] found=${raw.found} dataRows=${raw.rows.length} hasDomTotal=${!!raw.totalRow}`);
    if (!raw.found || !raw.rows.length) return [];

    const COLS = ["Date","Clicks","Started Registrations","Registrations","New Bettors",
        "Betting Players","Gross Win","Bonus Money","Casino Profit","Your Earnings"];

    const isDateVal = v => {
        const s = String(v || '').trim();
        return /^\d{1,2}\s+[A-Za-z]/.test(s) || /^[A-Za-z]+\s+\d{1,2}/.test(s) || /^\d{4}-\d{2}-\d{2}/.test(s);
    };
    const isTotalStr = v => { const s = String(v || '').trim().toLowerCase(); return s === 'total' || s === 'totals' || s === 'grand total' || s === ''; };

    const result = [COLS];
    let fallbackTotalRow = null;
    raw.rows.forEach(row => {
        const r = [...row]; while (r.length < 10) r.push('');
        const ten = r.slice(0, 10);
        if (isDateVal(ten[0])) { result.push(ten); }
        else if (isTotalStr(ten[0])) { ten[0] = 'Total'; fallbackTotalRow = ten; }
        else { logs.push(`[DEBUG] Skip non-date row: "${ten[0]}"`); }
    });

    let finalTotalRow = null;
    if (raw.totalRow && raw.totalRow.length > 0) {
        const r = [...raw.totalRow]; while (r.length < 10) r.push('');
        const ten = r.slice(0, 10); ten[0] = 'Total'; finalTotalRow = ten;
    } else if (fallbackTotalRow) { finalTotalRow = fallbackTotalRow; }
    if (finalTotalRow) result.push(finalTotalRow);

    logs.push(`[DEBUG] Final rows (incl header): ${result.length}`);
    return result;
}

// ═══════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════
(async () => {
    try {
        const config = process.env.CONFIG_JSON
            ? JSON.parse(process.env.CONFIG_JSON)
            : JSON.parse(fs.readFileSync('config.json', 'utf8'));
        const dashConfig = config.dashboards[dashboardKey];
        if (!dashConfig) { logStep(0, "Load configuration", false); throw new Error(`Dashboard '${dashboardKey}' not found`); }
        logStep(0, "Load configuration", true);
        response.logs.push(`[DEBUG] monthArg raw="${monthArg}" resolved="${resolvedMonth}"`);

        const { execSync } = require('child_process');
        let chromePath;
        try {
            const result = execSync(
                'find /opt/render/.cache/puppeteer -name "chrome" -type f ! -name "*.zip" 2>/dev/null | head -1'
            ).toString().trim();
            if (result) chromePath = result;
        } catch(e) { chromePath = null; }

        response.logs.push(`[DEBUG] Chrome found at: "${chromePath || 'auto'}"`);

        browser = await puppeteer.launch({
            headless: true,
            executablePath: chromePath || undefined,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process',
                '--no-zygote',
                '--disable-extensions',
                '--disable-background-networking',
                '--no-first-run',
                '--mute-audio'
            ],
            timeout: 60000
        });

        page = await browser.newPage();
        await page.setViewport({ width: 1366, height: 768 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        page.setDefaultNavigationTimeout(60000);
        page.setDefaultTimeout(60000);
        logStep(1, "Browser launched", true);

        if (dashboardKey === "rewards_affiliates") {
            await page.goto(dashConfig.login_url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
            await new Promise(r => setTimeout(r, 8000));
            logStep(2, "Login page loaded", true);

            const frames = page.frames();
            let targetFrame = page;
            for (const frame of frames) {
                const cnt = await frame.evaluate(() => document.querySelectorAll('input[type="text"],input[type="password"]').length).catch(() => 0);
                if (cnt > 0 && frame !== page) { targetFrame = frame; break; }
            }

            const userSel = await findAndFill(targetFrame, 'username', dashConfig.credentials.username, response.logs);
            await new Promise(r => setTimeout(r, 500));
            const passSel = await findAndFill(targetFrame, 'password', dashConfig.credentials.password, response.logs);
            await new Promise(r => setTimeout(r, 500));
            if (!userSel || !passSel) { logStep(3, "Login fields not found", false); finish(false); return; }
            logStep(3, "Credentials injected", true);

            const submitSel = await findAndClickSubmit(targetFrame, response.logs);
            if (!submitSel) { logStep(3.5, "Submit not found", false); finish(false); return; }
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => null),
                targetFrame.click(submitSel)
            ]);
            await new Promise(r => setTimeout(r, 8000));
            if (page.url().toLowerCase().includes('login')) { logStep(4, "Login FAILED", false); finish(false); return; }
            logStep(4, "Login success", true);

            await page.goto(dashConfig.report_url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => null);
            await new Promise(r => setTimeout(r, 8000));
            logStep(5, `Report page: ${page.url()}`, true);

            try {
                const filterRes = await rewardsApplyFilters(page, site, resolvedMonth, response.logs);
                logStep(6, `Filters applied`, true);
            } catch(e) { logStep(6, `Filter error: ${e.message}`, false); }

            const rawRows = await rewardsAffiliateFetchTable(page, response.logs);
            const n = v => { const s = String(v||'').trim(); if (!s||s==='-') return 0; const isNeg = s.startsWith('(')&&s.endsWith(')'); const clean = s.replace(/[$,€()]/g,'').replace('%','').trim(); const num = parseFloat(clean); return isNaN(num)?0:isNeg?-num:num; };

            let dataMatrix = rawRows.map((row, idx) => {
                if (idx === 0) return row;
                return [row[0]||'', n(row[1]),n(row[2]),n(row[3]),n(row[4]),n(row[5]),n(row[6]),n(row[7]),n(row[8]),n(row[9])];
            });

            const isCurrentMonth = resolvedMonth.toLowerCase().includes(new Date().toLocaleString('en',{month:'long'}).toLowerCase()) && resolvedMonth.includes(String(new Date().getFullYear()));
            if (isCurrentMonth) { dataMatrix = filterRowsUpToToday(dataMatrix); response.logs.push(`[DEBUG] Filtered to today: ${dataMatrix.length} rows`); }

            response.data = dataMatrix;
            logStep(10, `Done rows: ${dataMatrix.length}`, dataMatrix.length > 1);
            finish(dataMatrix.length > 1);

        } else {
            // RO_AFFILIATE — FIXED: 15000 → 5000
            await page.goto(dashConfig.login_url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
            await new Promise(r => setTimeout(r, 5000));
            logStep(2, "Login page loaded", true);

            const uSel = 'input[type="text"], input[type="email"], input[id*="username"]';
            const pSel = 'input[type="password"]';
            const bSel = 'button[type="submit"], input[type="submit"]';

            await page.waitForSelector(uSel, { visible: true, timeout: 20000 });
            const uF = await page.$(uSel);
            await uF.click({ clickCount: 3 }); await uF.press('Backspace');
            await uF.type(dashConfig.credentials.username, { delay: 80 });
            await page.waitForSelector(pSel, { visible: true, timeout: 10000 });
            const pF = await page.$(pSel);
            await pF.click({ clickCount: 3 }); await pF.press('Backspace');
            await pF.type(dashConfig.credentials.password, { delay: 80 });
            logStep(3, "Credentials injected", true);

            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => null),
                page.click(bSel)
            ]);
            await new Promise(r => setTimeout(r, 5000));
            logStep(4, "Logged in", true);

            const cleanType = (reportTypeArg || '').toLowerCase().trim();
            const targetUrl = cleanType === "finance"
                ? "https://ro-affiliate.digika.com/reports/finance"
                : cleanType === "customers"
                ? "https://ro-affiliate.digika.com/reports/customers"
                : "https://ro-affiliate.digika.com/reports/general";

            await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => null);
            await new Promise(r => setTimeout(r, 6000));
            logStep(5, `Report page: ${targetUrl}`, true);

            const dateOk = await applyDateFilter(page, resolvedMonth, response.logs);
            logStep(6, `Date filter "${resolvedMonth}": ${dateOk ? 'OK' : 'check logs'}`, true);
            await new Promise(r => setTimeout(r, 2000));

            let rows = [];
            if (cleanType === "customers") {
                rows = await roAffiliateCustomers(page, resolvedMonth, response.logs);
            } else {
                rows = await roAffiliateGeneralFinance(page, resolvedMonth, response.logs);
            }

           response.logs.push(`[DEBUG] Harvested: ${rows.length} rows`);
    
    // ✅ FIX: Agar data nahi aaya to sirf headers sheet mein likho
    if (!rows || rows.length === 0) {
        const fallbackHeaders = [["Customer ID", "Gender", "Geo", "Signup Date", "Company", "Affiliate", "Status"]];
        response.data = fallbackHeaders;
        logStep(10, "No data — writing headers only", false);
        finish(false);
        return;
    }
    const n = v => {
                if (v === undefined || v === null || v === '') return 0;
                const clean = String(v).replace(/[€$,]/g,'').replace('%','').trim();
                const num = Number(clean); return isNaN(num) ? v : num;
            };

            let dataMatrix = rows.map((row, idx) => {
                if (idx === 0) return row;
                const r = [row[0] || ''];
                for (let i = 1; i < row.length; i++) r.push(n(row[i]));
                return r;
            });

            const now = new Date();
            const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
            const isCurrentMonth = resolvedMonth === `${monthNames[now.getMonth()]} ${now.getFullYear()}`;
            if (isCurrentMonth) { dataMatrix = filterRowsUpToToday(dataMatrix); response.logs.push(`[DEBUG] RO filtered to today: ${dataMatrix.length} rows`); }

            response.data = dataMatrix;
            logStep(10, `Done rows: ${dataMatrix.length}`, dataMatrix.length > 1);
            finish(dataMatrix.length > 1);
        }

    } catch(e) {
        response.logs.push(`[CRASH_ERROR] ${e.message}`);
        response.logs.push(`[CRASH_STACK] ${e.stack}`);
        finish(false);
    } finally {
        if (browser) await browser.close();
    }
})();