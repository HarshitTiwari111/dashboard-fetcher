<?php
// Set CORS headers for Google Apps Script
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Content-Type: application/json');

// Handle preflight OPTIONS request
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit(0);
}

// Windows local server ke hisaab se paths change kar diye hain
define('NODE_PATH', 'node'); 
define('SCRAPER_PATH', 'C:/xampp/htdocs/Project/dashboard-fetcher/scraper.js');

// 1. Read JSON input
$input = file_get_contents('php://input');
$request = json_decode($input, true);

if (!$request || !isset($request['dashboard']) || !isset($request['site']) || !isset($request['month'])) {
    echo json_encode([
        "success" => false,
        "logs" => ["[BRIDGE] Missing required parameters (dashboard, site, month)"]
    ]);
    exit;
}

// 2. Escape arguments to prevent command injection
$dashboard = escapeshellarg($request['dashboard']);
$site = escapeshellarg($request['site']);
$month = escapeshellarg($request['month']);

// 🔥 FIRED: Dynamic Report Type variable safely handled
$reportTypeVal = isset($request['report_type']) ? $request['report_type'] : 'General';
$report_type = escapeshellarg($reportTypeVal);

$nodePath = NODE_PATH;
$scraperPath = SCRAPER_PATH;

// 3. Construct and run the command (Aakhiri mein $report_type inject kar diya hai)
$command = "$nodePath $scraperPath $dashboard $site $month $report_type 2>&1";
exec($command, $outputArray, $returnVar);

// 4. Parse the output
$outputString = implode("\n", $outputArray);
$parsedJson = json_decode($outputString, true);

// 5. Return response
if (json_last_error() === JSON_ERROR_NONE && is_array($parsedJson)) {
    // Node script returned valid JSON
    echo $outputString;
} else {
    // Node script crashed or returned non-JSON output
    echo json_encode([
        "success" => false,
        "logs" => [
            "[BRIDGE] Node execution failed or returned invalid JSON.",
            "[BRIDGE] Return Code: " . $returnVar,
            "[BRIDGE] Raw Output: " . $outputString
        ]
    ]);
}
?>