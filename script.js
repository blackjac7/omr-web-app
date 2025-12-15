// Global variables
let keyAnswers = {}; // {1: 2, 2: 0 ...}
let processingMode = 'key'; // 'key' or 'student'

// Configuration for User's LJK (A4, 45 Soal)
// Based on generate_test_image.py logic (mm coordinates)
const CONFIG = {
    widthMM: 210,
    heightMM: 297,
    anchorSizeMM: 15,
    anchorMarginMM: 15,
    // Model Anchor Centers (TL, TR, BL, BR)
    anchors: [
        {x: 22.5, y: 22.5},  // TL (15 + 15/2)
        {x: 187.5, y: 22.5}, // TR (210 - 15 - 15/2)
        {x: 22.5, y: 274.5}, // BL (297 - 15 - 15/2)
        {x: 187.5, y: 274.5} // BR
    ],
    // Bubble Geometry
    colStartX: 20,
    colWidth: (210 - 40) / 3, // ~56.66
    bubbleStartY: 110,
    rowHeight: 9,
    bubbleRadiusMM: 2.5,
    bubbleGapMM: 8,
    firstBubbleOffsetMM: 25,
    verticalAlignOffset: 3
};

// --- DOM Elements ---
const keyInput = document.getElementById('keyInput');
const studentInput = document.getElementById('studentInput');
const keyStatus = document.getElementById('keyStatus');
const resultCanvas = document.getElementById('resultCanvas');
const scoreDisplay = document.getElementById('scoreDisplay');
const keyCanvas = document.getElementById('keyCanvas');

// --- Event Listeners ---
keyInput.addEventListener('change', (e) => handleImageUpload(e, 'key'));
studentInput.addEventListener('change', (e) => handleImageUpload(e, 'student'));

function handleImageUpload(e, type) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
            if (type === 'key') processKey(img);
            else processStudent(img);
        };
        img.src = event.target.result;
    };
    reader.readAsDataURL(file);
}

// --- Image Processing Pipeline ---

function processKey(imgElement) {
    keyStatus.innerText = "Memproses Kunci Jawaban...";
    keyStatus.style.color = "black";
    processingMode = 'key';
    
    setTimeout(() => { // Allow UI to update
        const results = processLJK(imgElement);
        if (results.error) {
            keyStatus.innerHTML = `<span class='error'>${results.error}</span>`;
            return;
        }
        
        keyAnswers = results.answers;
        keyStatus.innerHTML = `<strong>Kunci Jawaban Terdeteksi:</strong> ${Object.keys(keyAnswers).length} soal. <br>Silakan upload lembar siswa.`;
        keyStatus.style.color = "green";
        studentInput.disabled = false;
        
        // Draw visualization
        cv.imshow('keyCanvas', results.visual);
        document.getElementById('keyCanvas').style.display = 'block';
        results.cleanup();
    }, 100);
}

function processStudent(imgElement) {
    scoreDisplay.innerText = "Menilai...";
    processingMode = 'student';
    
    setTimeout(() => {
        const results = processLJK(imgElement);
        if (results.error) {
            alert(results.error);
            scoreDisplay.innerText = "Gagal.";
            return;
        }
        
        // Grading
        let score = 0;
        let total = Object.keys(keyAnswers).length;
        let studentAns = results.answers;
        let visual = results.visual;

        // Draw Feedback on Visual
        // Since 'visual' is the warped image (flat A4), it's easy to draw exactly where we checked.
        
        for (let q in keyAnswers) {
            const correctOpt = keyAnswers[q];
            const studentOpt = studentAns[q];

            // Re-calculate position for drawing feedback
            // (Duplicate logic from scanBubbles, ideally refactor)
            let colIdx = Math.floor((q - 1) / 15);
            let rowIdx = (q - 1) % 15;
            let colX = CONFIG.colStartX + (colIdx * CONFIG.colWidth);
            let rowY = CONFIG.bubbleStartY + (rowIdx * CONFIG.rowHeight);

            // Draw Check or Cross
            // Position: Left of the number
            let markX = (colX + 5) * 10; // 10px/mm scale
            let markY = (rowY + CONFIG.verticalAlignOffset) * 10;

            if (studentOpt === correctOpt) {
                score++;
                cv.putText(visual, "O", new cv.Point(markX - 30, markY+10), cv.FONT_HERSHEY_SIMPLEX, 0.8, new cv.Scalar(0, 200, 0, 255), 2);
            } else {
                cv.putText(visual, "X", new cv.Point(markX - 30, markY+10), cv.FONT_HERSHEY_SIMPLEX, 0.8, new cv.Scalar(255, 0, 0, 255), 2);

                // Highlight the correct answer if missed
                let correctCX = (colX + CONFIG.firstBubbleOffsetMM + correctOpt * CONFIG.bubbleGapMM) * 10;
                let correctCY = (rowY + CONFIG.verticalAlignOffset) * 10;
                cv.circle(visual, new cv.Point(correctCX, correctCY), 15, new cv.Scalar(0, 200, 0, 255), 2);
            }
        }
        
        let finalScore = total > 0 ? Math.round((score / total) * 100) : 0;
        scoreDisplay.innerText = `Nilai: ${finalScore} (${score}/${total})`;
        
        cv.imshow('resultCanvas', visual);
        results.cleanup();
    }, 100);
}

// --- Core Logic ---

function processLJK(imgElement) {
    let src = cv.imread(imgElement);

    // Resize for consistency/speed (limit width to 1500px)
    let scale = 1500 / src.cols;
    let dsize = new cv.Size(1500, Math.round(src.rows * scale));
    let img = new cv.Mat();
    cv.resize(src, img, dsize, 0, 0, cv.INTER_AREA);
    src.delete();

    // 1. Find Anchors
    let gray = new cv.Mat();
    cv.cvtColor(img, gray, cv.COLOR_RGBA2GRAY);
    
    let blur = new cv.Mat();
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

    let thresh = new cv.Mat();
    // Binary Inv: Markers become White, Background Black
    cv.adaptiveThreshold(blur, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C,
                         cv.THRESH_BINARY_INV, 11, 2);

    let contours = new cv.MatVector();
    let hierarchy = new cv.Mat();
    cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let anchors = [];
    let imgArea = img.cols * img.rows;
    
    for (let i = 0; i < contours.size(); i++) {
        let cnt = contours.get(i);
        let area = cv.contourArea(cnt);
        
        // Filter by Area (Adjust based on expected size of 15x15mm in A4)
        // 15mm/210mm ~ 7%. (15/210)^2 ~ 0.5% of area.
        // Let's be generous: 0.1% to 5%.
        if (area > imgArea * 0.001 && area < imgArea * 0.05) {
            let peri = cv.arcLength(cnt, true);
            let approx = new cv.Mat();
            cv.approxPolyDP(cnt, approx, 0.04 * peri, true);
            
            if (approx.rows === 4) {
                // Check Aspect Ratio ~ 1.0
                let rect = cv.boundingRect(approx);
                let aspect = rect.width / rect.height;
                if (aspect > 0.8 && aspect < 1.2) {
                    // Check solidity
                    let hull = new cv.Mat();
                    cv.convexHull(cnt, hull);
                    let hullArea = cv.contourArea(hull);
                    let solidity = area / hullArea;
                    hull.delete();
                    
                    if (solidity > 0.9) {
                        // Found a square candidate
                        // Store center point
                        let M = cv.moments(cnt, false);
                        let cx = M.m10 / M.m00;
                        let cy = M.m01 / M.m00;
                        anchors.push({x: cx, y: cy, cnt: cnt}); // cnt for debug
                    }
                }
            }
            approx.delete();
        }
    }
    
    if (anchors.length !== 4) {
        gray.delete(); blur.delete(); thresh.delete(); contours.delete(); hierarchy.delete();
        // Debug: Draw candidates found
        let debugImg = img.clone();
        for(let a of anchors) {
            cv.drawContours(debugImg, contours, -1, new cv.Scalar(0,0,255,255), 2); // Draw all
        }
        return { error: `Gagal deteksi 4 marker. Ditemukan ${anchors.length}. Pastikan foto memuat 4 kotak hitam di pojok.`, visual: debugImg, cleanup: () => { img.delete(); debugImg.delete(); } };
    }

    // Sort Anchors: TL, TR, BL, BR
    // Sort by Y first (Top vs Bottom)
    anchors.sort((a, b) => a.y - b.y);
    let top = anchors.slice(0, 2).sort((a, b) => a.x - b.x);
    let bottom = anchors.slice(2, 4).sort((a, b) => a.x - b.x);

    let srcPts = [top[0], top[1], bottom[0], bottom[1]]; // TL, TR, BL, BR

    // 2. Warp Perspective
    // Target Size: 10 pixels per mm (High Res)
    // A4: 2100 x 2970
    let scaleFactor = 10;
    let dstW = CONFIG.widthMM * scaleFactor;
    let dstH = CONFIG.heightMM * scaleFactor;
    
    let srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
        srcPts[0].x, srcPts[0].y,
        srcPts[1].x, srcPts[1].y,
        srcPts[2].x, srcPts[2].y,
        srcPts[3].x, srcPts[3].y
    ]);

    // Target Anchors (Based on CONFIG)
    let dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
        CONFIG.anchors[0].x * scaleFactor, CONFIG.anchors[0].y * scaleFactor,
        CONFIG.anchors[1].x * scaleFactor, CONFIG.anchors[1].y * scaleFactor,
        CONFIG.anchors[2].x * scaleFactor, CONFIG.anchors[2].y * scaleFactor,
        CONFIG.anchors[3].x * scaleFactor, CONFIG.anchors[3].y * scaleFactor
    ]);

    let M = cv.getPerspectiveTransform(srcTri, dstTri);
    let warped = new cv.Mat();
    cv.warpPerspective(img, warped, M, new cv.Size(dstW, dstH));

    // Clean up early stages
    gray.delete(); blur.delete(); thresh.delete(); contours.delete(); hierarchy.delete();
    srcTri.delete(); dstTri.delete(); M.delete(); img.delete();

    // 3. Scan Bubbles
    // Process warped image (convert to gray/thresh again?)
    let wGray = new cv.Mat();
    cv.cvtColor(warped, wGray, cv.COLOR_RGBA2GRAY);
    let wThresh = new cv.Mat();
    // Threshold to find black marks.
    cv.threshold(wGray, wThresh, 150, 255, cv.THRESH_BINARY_INV);
    
    let answers = {};
    
    // Iterate 45 Questions
    for (let q = 1; q <= 45; q++) {
        let colIdx = Math.floor((q - 1) / 15); // 0, 1, 2
        let rowIdx = (q - 1) % 15; // 0..14
        
        let colX = CONFIG.colStartX + (colIdx * CONFIG.colWidth);
        let rowY = CONFIG.bubbleStartY + (rowIdx * CONFIG.rowHeight);
        
        // Find best option for this question
        let bestOpt = -1;
        let maxPixels = 0;
        
        for (let opt = 0; opt < 5; opt++) {
            let cx = colX + CONFIG.firstBubbleOffsetMM + (opt * CONFIG.bubbleGapMM);
            let cy = rowY + CONFIG.verticalAlignOffset;
            
            // Define ROI around bubble
            // Radius 2.5mm -> Diameter 5mm. ROI 6x6mm?
            let rMM = 3;
            let rx = Math.round((cx - rMM) * scaleFactor);
            let ry = Math.round((cy - rMM) * scaleFactor);
            let rw = Math.round(rMM * 2 * scaleFactor);
            let rh = Math.round(rMM * 2 * scaleFactor);
            
            let roi = wThresh.roi(new cv.Rect(rx, ry, rw, rh));
            let count = cv.countNonZero(roi);
            roi.delete();
            
            // Debug Visualization: Draw ROI on warped image
            let color = new cv.Scalar(200, 200, 200, 255);
            if (count > 100) color = new cv.Scalar(0, 0, 255, 255); // Candidate
            cv.rectangle(warped, new cv.Point(rx, ry), new cv.Point(rx+rw, ry+rh), color, 1);

            // Threshold logic
            // A full circle (r=2.5mm) area ~ 20mm^2. At 10px/mm -> 2000 pixels.
            // A check mark might be 200-500 pixels.
            // "Hitamkan bulatan" should be > 1000 pixels.
            // Let's use a dynamic threshold or just relative max.

            if (count > maxPixels) {
                maxPixels = count;
                bestOpt = opt;
            }
        }
        
        // Final Decision
        // Must have significant darkness. e.g., > 20% fill?
        // Full circle area approx 2000 px.
        if (maxPixels > 300) { // Tolerant threshold
            answers[q] = bestOpt;

            // Draw detected answer (Green circle)
            let cx = CONFIG.colStartX + (colIdx * CONFIG.colWidth) + CONFIG.firstBubbleOffsetMM + (bestOpt * CONFIG.bubbleGapMM);
            let cy = CONFIG.bubbleStartY + (rowIdx * CONFIG.rowHeight) + CONFIG.verticalAlignOffset;

            cv.circle(warped, new cv.Point(cx*scaleFactor, cy*scaleFactor), 20, new cv.Scalar(0, 255, 0, 255), 2);
        }
    }
    
    wGray.delete(); wThresh.delete();
    
    return { answers: answers, visual: warped, cleanup: () => { warped.delete(); } };
}
