// Global variables
let keyAnswers = {}; // {1: 2, 2: 0 ...}
let processingMode = 'key'; // 'key' or 'student'

// Configuration for User's LJK (3 Cols, 15 Rows each)
const CONFIG = {
    tables: 3,
    rowsPerTable: 16, // 1 Header + 15 Data
    colsPerTable: 6,  // NO + A-E
    questionsPerTable: 15,
    expectedRatio: 0.42, // Width/Height approx. 265/619 = 0.42
    ratioTolerance: 0.2
};

// --- DOM Elements ---
const keyInput = document.getElementById('keyInput');
const studentInput = document.getElementById('studentInput');
const keyStatus = document.getElementById('keyStatus');
const resultCanvas = document.getElementById('resultCanvas');
const scoreDisplay = document.getElementById('scoreDisplay');

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
    processingMode = 'key';
    
    setTimeout(() => { // Allow UI to update
        const results = processLJK(imgElement);
        if (results.error) {
            keyStatus.innerHTML = `<span class='error'>${results.error}</span>`;
            return;
        }
        
        keyAnswers = results.answers;
        keyStatus.innerText = `Kunci Jawaban Terdeteksi: ${Object.keys(keyAnswers).length} soal.`;
        studentInput.disabled = false;
        
        // Draw visualization of detection
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
            return;
        }
        
        // Grading
        let score = 0;
        let total = Object.keys(keyAnswers).length;
        let studentAns = results.answers;
        
        // Draw results
        let visual = results.visual;
        
        // Since 'visual' is the original image with drawn contours, we want to overlay feedback.
        // However, the 'processLJK' function works on warped tables.
        // Mapping back to original image is complex without keeping the homography matrices.
        // For simplicity, we will just display the result text and the detected grid on the original image.
        
        for (let q in keyAnswers) {
            if (studentAns[q] === keyAnswers[q]) {
                score++;
            }
        }
        
        let finalScore = Math.round((score / total) * 100);
        scoreDisplay.innerText = `Nilai: ${finalScore} (${score}/${total})`;
        
        cv.imshow('resultCanvas', visual);
        results.cleanup();
    }, 100);
}

// --- Core Logic ---

function processLJK(imgElement) {
    let src = cv.imread(imgElement);
    let dsize = new cv.Size(1000, Math.round(src.rows * (1000/src.cols)));
    let img = new cv.Mat();
    cv.resize(src, img, dsize, 0, 0, cv.INTER_AREA);
    src.delete();

    // 1. Preprocessing
    let gray = new cv.Mat();
    cv.cvtColor(img, gray, cv.COLOR_RGBA2GRAY);
    
    let thresh = new cv.Mat();
    cv.adaptiveThreshold(gray, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, 
                         cv.THRESH_BINARY_INV, 11, 2);

    // 2. Find Tables
    let contours = new cv.MatVector();
    let hierarchy = new cv.Mat();
    cv.findContours(thresh, contours, hierarchy, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);

    let tables = [];
    let minArea = (img.rows * img.cols) * 0.01; // > 1% area
    
    for (let i = 0; i < contours.size(); i++) {
        let cnt = contours.get(i);
        let area = cv.contourArea(cnt);
        
        if (area > minArea) {
            let peri = cv.arcLength(cnt, true);
            let approx = new cv.Mat();
            cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
            
            if (approx.rows === 4) {
                let rect = cv.boundingRect(approx);
                let aspect = rect.width / rect.height;
                
                // Filter by aspect ratio (Tall rectangles)
                if (aspect > CONFIG.expectedRatio - CONFIG.ratioTolerance && 
                    aspect < CONFIG.expectedRatio + CONFIG.ratioTolerance) {
                    
                    // Convert approx to JS array of points
                    let points = [];
                    for(let j=0; j<4; j++) {
                        points.push({
                            x: approx.data32S[j*2],
                            y: approx.data32S[j*2+1]
                        });
                    }
                    tables.push({points, rect, area, cnt: cnt}); // Keep cnt for drawing
                }
            }
            approx.delete();
        }
    }

    // Sort tables Left to Right
    tables.sort((a, b) => a.rect.x - b.rect.x);
    
    // We expect at least 3 tables. If found more, take the largest 3 or best fit?
    // Let's take the 3 with similar Y coordinates?
    // For now, take the first 3 if sorted by X.
    if (tables.length < 3) {
        gray.delete(); thresh.delete(); contours.delete(); hierarchy.delete();
        return { error: `Gagal mendeteksi 3 kolom tabel. Ditemukan ${tables.length}. Pastikan foto jelas dan lurus.`, cleanup: () => img.delete() };
    }
    
    tables = tables.slice(0, 3);
    
    // Process each table
    let answers = {};
    let visual = img.clone(); // For drawing debug
    
    tables.forEach((table, idx) => {
        // Draw the detected table contour
        // We need to reconstruct contour to draw it? 
        // Or just draw the rect
        let pt1 = new cv.Point(table.rect.x, table.rect.y);
        let pt2 = new cv.Point(table.rect.x + table.rect.width, table.rect.y + table.rect.height);
        cv.rectangle(visual, pt1, pt2, new cv.Scalar(255, 0, 0, 255), 3);
        
        // Warp Perspective
        // Order points: TL, TR, BR, BL
        let pts = orderPoints(table.points);
        
        let srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
            pts[0].x, pts[0].y,
            pts[1].x, pts[1].y,
            pts[2].x, pts[2].y,
            pts[3].x, pts[3].y
        ]);
        
        let w = table.rect.width;
        let h = table.rect.height;
        let dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
            0, 0, w, 0, w, h, 0, h
        ]);
        
        let M = cv.getPerspectiveTransform(srcTri, dstTri);
        let warped = new cv.Mat();
        cv.warpPerspective(thresh, warped, M, new cv.Size(w, h)); // Warp the thresholded image directly
        
        // Scan Grid
        let cellH = h / CONFIG.rowsPerTable;
        let cellW = w / CONFIG.colsPerTable;
        
        for (let row = 1; row < CONFIG.rowsPerTable; row++) { // Skip header (row 0)
            let qNum = (idx * CONFIG.questionsPerTable) + row;
            let bestOpt = -1;
            let maxCount = 0;
            
            let rowY = Math.floor(row * cellH);
            let nextRowY = Math.floor((row+1) * cellH);
            
            for (let col = 1; col < 6; col++) { // Cols 1-5 (A-E)
                let colX = Math.floor(col * cellW);
                let nextColX = Math.floor((col+1) * cellW);
                
                // Define ROI with margin to avoid border lines
                let margin = 5; 
                let rX = colX + margin;
                let rY = rowY + margin;
                let rW = (nextColX - colX) - (2 * margin);
                let rH = (nextRowY - rowY) - (2 * margin);
                
                if (rW <= 0 || rH <= 0) continue;
                
                let rectROI = new cv.Rect(rX, rY, rW, rH);
                let roi = warped.roi(rectROI);
                
                let count = cv.countNonZero(roi);
                roi.delete();
                
                // Draw grid on visual (Approximate mapping back is hard, so skipping detailed grid draw on visual)
                // Just log
                if (count > maxCount) {
                    maxCount = count;
                    bestOpt = col - 1;
                }
            }
            
            // Threshold for "Is Marked"
            if (maxCount > 30) { // Tunable threshold
                 answers[qNum] = bestOpt;
                 
                 // Visualize found answer on the Main Image (Approximation)
                 // We know the rect of the table.
                 // We can estimate the center of the cell in the original image
                 // x = table.x + (col * cellW) ... roughly
                 let optChar = ['A','B','C','D','E'][bestOpt];
                 let textPt = new cv.Point(table.rect.x + (bestOpt+1.5)*cellW, table.rect.y + (row+0.7)*cellH);
                 cv.putText(visual, optChar, textPt, cv.FONT_HERSHEY_SIMPLEX, 0.5, new cv.Scalar(0, 255, 0, 255), 2);
            }
        }
        
        srcTri.delete(); dstTri.delete(); M.delete(); warped.delete();
    });

    gray.delete(); thresh.delete(); contours.delete(); hierarchy.delete();
    
    return { answers, visual, cleanup: () => { img.delete(); visual.delete(); } };
}

// Helper: Order points TL, TR, BR, BL
function orderPoints(pts) {
    // Sort by Y to separate Top and Bottom
    pts.sort((a, b) => a.y - b.y);
    
    let top = pts.slice(0, 2).sort((a, b) => a.x - b.x); // TL, TR
    let bottom = pts.slice(2, 4).sort((a, b) => a.x - b.x); // BL, BR
    
    // Wait, BL and BR might be swapped if the rectangle is rotated.
    // Standard order: TL, TR, BR, BL
    return [top[0], top[1], bottom[1], bottom[0]];
}
