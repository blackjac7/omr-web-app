// Global variables
let keyAnswers = {}; // {1: 2, 2: 0 ...} (0=A, 1=B, 2=C, 3=D, 4=E)
let videoStream = null;
const NUM_QUESTIONS = 45;

// Configuration for User's LJK (A4, 45 Soal)
// Calibrated from provided template image
const CONFIG = {
    widthMM: 210,
    heightMM: 297,
    anchorSizeMM: 15,
    anchorMarginMM: 15,
    // Model Anchor Centers (TL, TR, BL, BR)
    anchors: [
        {x: 22.5, y: 22.5},  // TL
        {x: 187.5, y: 22.5}, // TR
        {x: 22.5, y: 274.5}, // BL
        {x: 187.5, y: 274.5} // BR
    ],
    // Bubble Geometry (Calibrated)
    colStartX: 20,
    colWidth: 56.77, // Calibrated
    bubbleStartY: 110,
    rowHeight: 7.28, // Calibrated
    bubbleRadiusMM: 2.5,
    bubbleGapMM: 8,
    firstBubbleOffsetMM: 27.4, // Calibrated
    verticalAlignOffset: 17.79 // Calibrated
};

// --- Digital Key Logic ---

function initKeyGrid() {
    const grid = document.getElementById('keyGrid');
    grid.innerHTML = '';

    // Load saved key if exists
    const savedKey = localStorage.getItem('ljk_key_answers');
    let savedObj = savedKey ? JSON.parse(savedKey) : {};

    for (let i = 1; i <= NUM_QUESTIONS; i++) {
        const div = document.createElement('div');
        div.className = 'key-item';

        const label = document.createElement('label');
        label.innerText = `No ${i}`;

        const select = document.createElement('select');
        select.id = `q_${i}`;

        ['A', 'B', 'C', 'D', 'E'].forEach((opt, idx) => {
            const option = document.createElement('option');
            option.value = idx;
            option.innerText = opt;
            if (savedObj[i] === idx) option.selected = true;
            select.appendChild(option);
        });

        div.appendChild(label);
        div.appendChild(select);
        grid.appendChild(div);
    }

    if (savedKey) {
        keyAnswers = savedObj;
        document.getElementById('stepCamera').classList.remove('hidden');
        document.getElementById('keyStatus').innerText = "Kunci jawaban dimuat dari memori.";
        document.getElementById('keyStatus').style.color = "green";
    }
}

// Auto-init grid when script loads (or DOM ready)
document.addEventListener('DOMContentLoaded', initKeyGrid);

function saveKey() {
    let newKey = {};
    for (let i = 1; i <= NUM_QUESTIONS; i++) {
        const val = document.getElementById(`q_${i}`).value;
        newKey[i] = parseInt(val);
    }
    keyAnswers = newKey;
    localStorage.setItem('ljk_key_answers', JSON.stringify(keyAnswers));
    
    document.getElementById('keyStatus').innerText = "Kunci Jawaban Tersimpan!";
    document.getElementById('keyStatus').style.color = "green";

    // Unlock next step
    document.getElementById('stepCamera').classList.remove('hidden');
    // Scroll to camera step
    document.getElementById('stepCamera').scrollIntoView({behavior: 'smooth'});
}


// --- Camera Logic ---

let autoScanInterval = null;
let lastAnchors = null;
let stabilityCounter = 0;
const STABILITY_THRESHOLD = 5; // px movement allowed
const STABILITY_FRAMES_REQUIRED = 8; // Number of stable frames before capture

async function startCamera() {
    const video = document.getElementById('videoFeed');
    const container = document.getElementById('cameraContainer');
    const btnStart = document.getElementById('btnStartCamera');

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: 'environment', // Back camera
                width: { ideal: 1920 },
                height: { ideal: 1080 }
            }
        });
        
        videoStream = stream;
        video.srcObject = stream;
        
        // UI Updates
        container.style.display = 'block';
        btnStart.style.display = 'none';
        document.getElementById('resultArea').classList.add('hidden');

        // Start Auto Scan Loop
        startAutoScanLoop();

    } catch (err) {
        alert("Gagal membuka kamera: " + err.message + "\nPastikan Anda memberikan izin kamera.");
    }
}

function stopCamera() {
    if (autoScanInterval) {
        clearInterval(autoScanInterval);
        autoScanInterval = null;
    }
    if (videoStream) {
        videoStream.getTracks().forEach(track => track.stop());
        videoStream = null;
    }
}

function resetCamera() {
    document.getElementById('resultArea').classList.add('hidden');
    document.getElementById('cameraContainer').style.display = 'block';
    // Restart camera if stopped (usually good to keep running or restart)
    if (!videoStream) startCamera();
    else startAutoScanLoop();
}

function startAutoScanLoop() {
    if (autoScanInterval) clearInterval(autoScanInterval);

    const guideOverlay = document.getElementById('guideOverlay');
    if(guideOverlay) guideOverlay.style.borderColor = "rgba(255, 255, 255, 0.5)";

    // Check stability every 200ms
    autoScanInterval = setInterval(checkAutoScan, 200);
}

function checkAutoScan() {
    // Only check if we are in "camera mode"
    if (document.getElementById('cameraContainer').style.display === 'none') return;

    const video = document.getElementById('videoFeed');
    if (video.videoWidth === 0) return;

    // Use a small canvas for speed
    const canvas = document.createElement('canvas');
    let scale = 0.25; // process at 1/4 resolution
    canvas.width = video.videoWidth * scale;
    canvas.height = video.videoHeight * scale;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const img = cv.imread(canvas);
    const anchors = findAnchors(img); // Reuse logic, but separate function
    img.delete();

    const statusOverlay = document.getElementById('scanStatus');

    if (!anchors || anchors.length !== 4) {
        stabilityCounter = 0;
        lastAnchors = null;
        if(statusOverlay) statusOverlay.innerText = "Arahkan ke 4 kotak hitam...";
        if(statusOverlay) statusOverlay.style.color = "white";

        const guide = document.getElementById('guideOverlay');
        if(guide) guide.style.borderColor = "rgba(255, 255, 255, 0.5)";
        return;
    }

    // Anchors found - check stability
    // Sort anchors to be consistent
    anchors.sort((a, b) => a.y - b.y); // Rough sort

    if (lastAnchors) {
        let maxDist = 0;
        for (let i = 0; i < 4; i++) {
            let dx = anchors[i].x - lastAnchors[i].x;
            let dy = anchors[i].y - lastAnchors[i].y;
            let dist = Math.sqrt(dx*dx + dy*dy);
            if (dist > maxDist) maxDist = dist;
        }

        if (maxDist < STABILITY_THRESHOLD) {
            stabilityCounter++;
            if(statusOverlay) statusOverlay.innerText = `Tahan posisi... (${stabilityCounter}/${STABILITY_FRAMES_REQUIRED})`;
            if(statusOverlay) statusOverlay.style.color = "yellow";

            const guide = document.getElementById('guideOverlay');
            if(guide) guide.style.borderColor = "yellow";

            if (stabilityCounter >= STABILITY_FRAMES_REQUIRED) {
                // Trigger Capture!
                clearInterval(autoScanInterval);
                if(statusOverlay) statusOverlay.innerText = "Processing...";
                if(guide) guide.style.borderColor = "#00ff00";
                captureAndProcess();
            }
        } else {
            stabilityCounter = 0;
            if(statusOverlay) statusOverlay.innerText = "Stabilkan tangan...";
        }
    } else {
        stabilityCounter = 0;
    }

    lastAnchors = anchors;
}


function captureAndProcess() {
    const video = document.getElementById('videoFeed');
    const canvas = document.createElement('canvas'); // Temp canvas
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    
    // Draw current frame
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Process
    const btn = document.getElementById('btnCapture');
    const originalText = btn.innerText;
    btn.innerText = "Processing...";
    btn.disabled = true;

    // Small delay to allow UI render
    setTimeout(() => {
        const result = processLJKFromCanvas(canvas);
        
        btn.innerText = originalText;
        btn.disabled = false;
        
        if (result.error) {
            alert(result.error);
            // Resume scanning if failed
            startAutoScanLoop();
        } else {
            showResults(result);
        }
    }, 100);
}

function showResults(result) {
    // Stop auto scan
    if (autoScanInterval) clearInterval(autoScanInterval);

    document.getElementById('cameraContainer').style.display = 'none';
    const resArea = document.getElementById('resultArea');
    resArea.classList.remove('hidden');

    // Calculate Score
    let score = 0;
    let total = Object.keys(keyAnswers).length;
    let wrongList = [];

    const studentAns = result.answers;
    const visual = result.visual;

    for (let q in keyAnswers) {
        const correctOpt = keyAnswers[q];
        const studentOpt = studentAns[q];
        
        let colIdx = Math.floor((q - 1) / 15);
        let rowIdx = (q - 1) % 15;
        let colX = CONFIG.colStartX + (colIdx * CONFIG.colWidth);
        let rowY = CONFIG.bubbleStartY + (rowIdx * CONFIG.rowHeight);
        
        let markX = (colX + 5) * 10; // 10px/mm
        let markY = (rowY + CONFIG.verticalAlignOffset) * 10;

        if (studentOpt === correctOpt) {
            score++;
             cv.putText(visual, "O", new cv.Point(markX - 30, markY+10), cv.FONT_HERSHEY_SIMPLEX, 0.8, new cv.Scalar(0, 200, 0, 255), 2);
        } else {
            wrongList.push(q);
            cv.putText(visual, "X", new cv.Point(markX - 30, markY+10), cv.FONT_HERSHEY_SIMPLEX, 0.8, new cv.Scalar(255, 0, 0, 255), 2);

             let correctCX = (colX + CONFIG.firstBubbleOffsetMM + correctOpt * CONFIG.bubbleGapMM) * 10;
             let correctCY = (rowY + CONFIG.verticalAlignOffset) * 10;
             cv.circle(visual, new cv.Point(correctCX, correctCY), 15, new cv.Scalar(0, 200, 0, 255), 2);
        }
    }

    let finalScore = total > 0 ? Math.round((score / total) * 100) : 0;

    // Display Text
    document.getElementById('scoreDisplay').innerText = `Nilai: ${finalScore}`;

    const wrongDiv = document.getElementById('wrongAnswersDisplay');
    if (wrongList.length === 0) {
        wrongDiv.innerText = "Sempurna! Tidak ada yang salah.";
        wrongDiv.style.color = "green";
        wrongDiv.style.background = "#e6fffa";
    } else {
        wrongDiv.innerText = "Salah No: " + wrongList.join(', ');
        wrongDiv.style.color = "#dc3545";
        wrongDiv.style.background = "#fff5f5";
    }

    // Display Canvas
    cv.imshow('resultCanvas', visual);
    visual.delete();
}


// --- Core Logic (Refactored) ---

function findAnchors(img) {
    let gray = new cv.Mat();
    cv.cvtColor(img, gray, cv.COLOR_RGBA2GRAY);
    
    let blur = new cv.Mat();
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

    let thresh = new cv.Mat();
    cv.adaptiveThreshold(blur, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 11, 2);

    let contours = new cv.MatVector();
    let hierarchy = new cv.Mat();
    cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let anchors = [];
    let imgArea = img.cols * img.rows;
    
    for (let i = 0; i < contours.size(); i++) {
        let cnt = contours.get(i);
        let area = cv.contourArea(cnt);
        
        // Slightly relaxed constraints for detection
        if (area > imgArea * 0.0005 && area < imgArea * 0.05) {
            let peri = cv.arcLength(cnt, true);
            let approx = new cv.Mat();
            cv.approxPolyDP(cnt, approx, 0.04 * peri, true);
            
            if (approx.rows === 4) {
                let rect = cv.boundingRect(approx);
                let aspect = rect.width / rect.height;
                if (aspect > 0.7 && aspect < 1.3) {
                    let hull = new cv.Mat();
                    cv.convexHull(cnt, hull);
                    let hullArea = cv.contourArea(hull);
                    let solidity = area / hullArea;
                    hull.delete();
                    
                    if (solidity > 0.85) {
                        let M = cv.moments(cnt, false);
                        let cx = M.m10 / M.m00;
                        let cy = M.m01 / M.m00;
                        anchors.push({x: cx, y: cy});
                    }
                }
            }
            approx.delete();
        }
    }
    
    gray.delete(); blur.delete(); thresh.delete(); contours.delete(); hierarchy.delete();

    return anchors;
}

function processLJKFromCanvas(inputCanvas) {
    let src = cv.imread(inputCanvas);

    // Resize for consistency
    let scale = 1500 / src.cols;
    let dsize = new cv.Size(1500, Math.round(src.rows * scale));
    let img = new cv.Mat();
    cv.resize(src, img, dsize, 0, 0, cv.INTER_AREA);
    src.delete();

    // 1. Find Anchors
    let anchors = findAnchors(img);

    // Debug fail
    if (!anchors || anchors.length !== 4) {
        img.delete();
        return { error: `Gagal deteksi 4 marker. Ditemukan ${anchors ? anchors.length : 0}. Coba sesuaikan cahaya/posisi.` };
    }

    // Sort Anchors
    anchors.sort((a, b) => a.y - b.y);
    let top = anchors.slice(0, 2).sort((a, b) => a.x - b.x);
    let bottom = anchors.slice(2, 4).sort((a, b) => a.x - b.x);
    let srcPts = [top[0], top[1], bottom[0], bottom[1]];

    // 2. Warp
    let scaleFactor = 10;
    let dstW = CONFIG.widthMM * scaleFactor;
    let dstH = CONFIG.heightMM * scaleFactor;
    
    let srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
        srcPts[0].x, srcPts[0].y,
        srcPts[1].x, srcPts[1].y,
        srcPts[2].x, srcPts[2].y,
        srcPts[3].x, srcPts[3].y
    ]);

    let dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
        CONFIG.anchors[0].x * scaleFactor, CONFIG.anchors[0].y * scaleFactor,
        CONFIG.anchors[1].x * scaleFactor, CONFIG.anchors[1].y * scaleFactor,
        CONFIG.anchors[2].x * scaleFactor, CONFIG.anchors[2].y * scaleFactor,
        CONFIG.anchors[3].x * scaleFactor, CONFIG.anchors[3].y * scaleFactor
    ]);

    let M = cv.getPerspectiveTransform(srcTri, dstTri);
    let warped = new cv.Mat();
    cv.warpPerspective(img, warped, M, new cv.Size(dstW, dstH));

    srcTri.delete(); dstTri.delete(); M.delete(); img.delete();

    // 3. Scan Bubbles
    let wGray = new cv.Mat();
    cv.cvtColor(warped, wGray, cv.COLOR_RGBA2GRAY);
    let wThresh = new cv.Mat();
    // Use Adaptive Threshold for better lighting resilience
    cv.adaptiveThreshold(wGray, wThresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 15, 3);
    
    let answers = {};
    
    for (let q = 1; q <= NUM_QUESTIONS; q++) {
        let colIdx = Math.floor((q - 1) / 15);
        let rowIdx = (q - 1) % 15;
        let colX = CONFIG.colStartX + (colIdx * CONFIG.colWidth);
        let rowY = CONFIG.bubbleStartY + (rowIdx * CONFIG.rowHeight);
        
        let bestOpt = -1;
        let maxPixels = 0;
        
        for (let opt = 0; opt < 5; opt++) {
            let cx = colX + CONFIG.firstBubbleOffsetMM + (opt * CONFIG.bubbleGapMM);
            let cy = rowY + CONFIG.verticalAlignOffset;
            
            let rMM = 3;
            let rx = Math.round((cx - rMM) * scaleFactor);
            let ry = Math.round((cy - rMM) * scaleFactor);
            let rw = Math.round(rMM * 2 * scaleFactor);
            let rh = Math.round(rMM * 2 * scaleFactor);
            
            let roi = wThresh.roi(new cv.Rect(rx, ry, rw, rh));
            let count = cv.countNonZero(roi);
            roi.delete();
            
            if (count > maxPixels) {
                maxPixels = count;
                bestOpt = opt;
            }
        }
        
        // Threshold for valid fill (calibrated guess)
        if (maxPixels > 150) { // Lowered slightly since adaptive threshold might be cleaner
            answers[q] = bestOpt;
        }
    }
    
    wGray.delete(); wThresh.delete();
    
    return { answers: answers, visual: warped };
}
