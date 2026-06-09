const express = require("express");
const puppeteer = require("puppeteer");
const fs = require("fs");
const { google } = require("googleapis");
const { exec, execSync } = require('child_process');
const path = require('path');

const app = express();
app.use(express.json({ limit: "10mb" }));

const SHEET_ID = "1v4TBfbkFNISx33JWeqD-xZcedZRrf0OMow4u2VXLGIM";
const SHEET_TAB = "Test";

// ── AUTO INSTALL CHROME ON STARTUP ──
console.log("Checking Chrome installation...");
try {
  execSync('npx puppeteer browsers install chrome', { stdio: 'inherit' });
  console.log("Chrome install check complete!");
} catch (e) {
  console.log("Chrome install warning:", e.message);
}

async function getGoogleSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: "v4", auth: authClient });
}

async function writeToGoogleSheet(data) {
  const sheets = await getGoogleSheetsClient();
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:Z`,
  });
  const headers = Object.keys(data[0]);
  const rows = data.map((row) => Object.values(row));
  const values = [headers, ...rows];
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
  console.log(`Google Sheet updated: ${values.length - 1} data rows written`);
}

// ── HOME ──
app.get("/", (req, res) => {
  res.send("Dashboard Fetcher Running");
});

// ── BRIDGE ROUTE ──
app.post('/bridge', (req, res) => {
  const { dashboard, site, month, report_type } = req.body;

  if (!dashboard || !site || !month) {
    return res.json({ success: false, logs: ['Missing parameters'] });
  }

  const scraperPath = path.join(__dirname, 'scraper.js');
  const reportType = report_type || 'General';
  const command = `node "${scraperPath}" "${dashboard}" "${site}" "${month}" "${reportType}"`;

  console.log('Running:', command);

  // ✅ Timeout 3 min + maxBuffer 10MB
  exec(command, { timeout: 180000, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
    
    if (error) {
      console.log('Exec error:', error.message);
      console.log('Stderr:', stderr ? stderr.substring(0, 300) : 'none');
    }

    const rawOutput = (stdout || '').trim();
    console.log('Raw output length:', rawOutput.length);
    console.log('Raw output preview:', rawOutput.substring(0, 200));

    if (!rawOutput) {
      return res.json({
        success: false,
        logs: [
          '[BRIDGE] Scraper ne koi output nahi diya.',
          '[BRIDGE] Error: ' + (error ? error.message : 'Unknown'),
          '[BRIDGE] Stderr: ' + (stderr ? stderr.substring(0, 200) : 'none')
        ]
      });
    }

    // JSON last line se nikalo (scraper console logs bhi print karta hai)
    const lines = rawOutput.split('\n');
    let jsonResult = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('{') && line.endsWith('}')) {
        try {
          jsonResult = JSON.parse(line);
          break;
        } catch(e) {}
      }
    }

    if (jsonResult) {
      return res.json(jsonResult);
    }

    // Fallback — poora output parse karo
    try {
      const result = JSON.parse(rawOutput);
      res.json(result);
    } catch (e) {
      res.json({
        success: false,
        logs: [
          '[BRIDGE] Response JSON parse karne mein error.',
          '[BRIDGE] Parse error: ' + e.message,
          '[BRIDGE] Raw response (first 300 chars): ' + rawOutput.substring(0, 300)
        ]
      });
    }
  });
});

// ── FETCH ROUTE ──
app.post("/fetch", async (req, res) => {
  let browser;
  try {
    const { dashboardUrl, username, password, casinoValue, monthValue } = req.body;

    console.log("\n==============================");
    console.log("NEW REQUEST");
    console.log("Dashboard URL:", dashboardUrl);
    console.log("Username:", username);
    console.log("Casino:", casinoValue);
    console.log("Month:", monthValue);
    console.log("==============================\n");

    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });

    const page = await browser.newPage();

    console.log("Opening Login Page...");
    await page.goto(dashboardUrl, { waitUntil: "networkidle2", timeout: 60000 });

    await page.waitForSelector(
      "#ctl00_ctl00_ContentPlaceHolderBody_ContentPlaceHolderBodyLO_txtLoginUsername",
      { timeout: 30000 }
    );
    await page.type(
      "#ctl00_ctl00_ContentPlaceHolderBody_ContentPlaceHolderBodyLO_txtLoginUsername",
      username
    );
    await page.type(
      "#ctl00_ctl00_ContentPlaceHolderBody_ContentPlaceHolderBodyLO_txtLoginPassword",
      password
    );

    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }),
      page.click(
        "#ctl00_ctl00_ContentPlaceHolderBody_ContentPlaceHolderBodyLO_ButtonSubmitPage"
      ),
    ]);

    console.log("LOGIN SUCCESS");

    await page.goto(
      "https://www.rewardsaffiliates.com/members/affiliate/revshare/revshare_monthly.aspx",
      { waitUntil: "networkidle2", timeout: 60000 }
    );
    console.log("Report Page Opened");

    const selects = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("select")).map(s => ({
        id: s.id,
        name: s.name
      }));
    });
    console.log("SELECT ELEMENTS:", JSON.stringify(selects, null, 2));

    const casinoSelector =
      "#ctl00_ctl00_ContentPlaceHolderBody_ContentPlaceHolderBodyLI_ddlCasino";
    const casinoExists = await page
      .waitForSelector(casinoSelector, { timeout: 4000 })
      .then(() => true)
      .catch(() => false);

    if (casinoExists) {
      await page.select(casinoSelector, casinoValue);
      console.log("Casino Selected:", casinoValue);
    } else {
      console.log("Casino Dropdown Not Found — skipping");
    }

    const monthSelector =
      "#ctl00_ctl00_ContentPlaceHolderBody_ContentPlaceHolderBodyLI_ddlDate";
    await page.waitForSelector(monthSelector, { timeout: 30000 });
    await page.select(monthSelector, monthValue);
    console.log("Month Selected:", monthValue);

    console.log("Clicking GO...");
    await page.click(
      "#ctl00_ctl00_ContentPlaceHolderBody_ContentPlaceHolderBodyLI_btnGo"
    );
    console.log("Waiting for postback...");

    try {
      await page.waitForFunction(
        () => {
          const progress = document.querySelector(
            "[id*='UpdateProgress'], [id*='updateprogress'], .updateProgress"
          );
          if (progress) {
            return (
              progress.style.display === "none" ||
              progress.style.visibility === "hidden"
            );
          }
          return true;
        },
        { timeout: 15000 }
      );
      console.log("Postback complete");
    } catch (e) {
      console.log("UpdateProgress wait timed out — using fallback delay");
    }

    await new Promise((r) => setTimeout(r, 5000));
    await page.waitForNetworkIdle({ idleTime: 2000, timeout: 15000 }).catch(() => {});

    const frames = page.frames();
    let targetFrame = page.mainFrame();
    for (const frame of frames) {
      const url = frame.url();
      if (url.includes("revshare") || url.includes("report") || url.includes("affiliate")) {
        if (url !== page.url()) { targetFrame = frame; break; }
      }
    }

    const debugInfo = await targetFrame.evaluate(() => {
      const tables = document.querySelectorAll("table");
      return Array.from(tables).map((table, i) => {
        const rows = table.querySelectorAll("tr");
        return {
          tableIndex: i,
          id: table.id || "",
          className: table.className || "",
          totalRows: rows.length,
          totalTds: table.querySelectorAll("td").length,
          totalThs: table.querySelectorAll("th").length,
          rowColCounts: Array.from(rows).slice(0, 10).map((r) => ({
            tds: r.querySelectorAll("td").length,
            ths: r.querySelectorAll("th").length,
            preview: Array.from(r.querySelectorAll("td, th")).slice(0, 5).map((c) => c.textContent.trim().substring(0, 30)),
          })),
        };
      });
    });

    const data = await targetFrame.evaluate(() => {
      const keys = ["date","clicks","startedRegistrations","registrations","newBettors",
        "bettingPlayers","grossWin","bonusMoney","casinoProfit","yourEarnings"];
      const tables = document.querySelectorAll("table");
      let bestTable = null; let bestCount = 0;
      tables.forEach((table) => {
        const count = table.querySelectorAll("td, th").length;
        if (count > bestCount) { bestCount = count; bestTable = table; }
      });
      if (!bestTable) return { rows: [], colCount: 0 };
      const allRows = bestTable.querySelectorAll("tr");
      let maxCols = 0;
      allRows.forEach((row) => { const c = row.querySelectorAll("td, th").length; if (c > maxCols) maxCols = c; });
      const minCols = Math.max(maxCols - 2, 2);
      const result = []; let headerSkipped = false;
      allRows.forEach((row) => {
        const cols = row.querySelectorAll("td, th");
        if (cols.length < minCols) return;
        const cellText = Array.from(cols).map((c) => c.textContent.trim());
        if (cellText.every((c) => c === "")) return;
        if (!headerSkipped) { headerSkipped = true; return; }
        const rowObj = {};
        cellText.forEach((text, index) => {
          const key = keys[index] !== undefined ? keys[index] : `col_${index + 1}`;
          rowObj[key] = text;
        });
        result.push(rowObj);
      });
      return { rows: result, colCount: maxCols };
    });

    console.log("Column Count:", data.colCount);
    console.log("Total Data Rows:", data.rows.length);

    await browser.close();
    browser = null;

    if (data.rows.length > 0) {
      console.log("\nWriting to Google Sheets...");
      await writeToGoogleSheet(data.rows);
      console.log("Google Sheets write complete!");
    }

    res.json({
      success: true,
      rows: data.rows.length,
      colCount: data.colCount,
      data: data.rows,
      sheetUpdated: data.rows.length > 0,
      debugTables: debugInfo,
    });

  } catch (error) {
    console.error("\nERROR:", error.message);
    try { if (browser) await browser.close(); } catch (e) {}
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── START SERVER ──
app.listen(process.env.PORT || 3000, () => {
  console.log("Server Running On Port", process.env.PORT || 3000);
});