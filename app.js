/* ================= FIREBASE SETUP ================= */
const auth = firebase.auth();
const db = firebase.firestore();
const googleProvider = new firebase.auth.GoogleAuthProvider();

let currentUser = null;

/* ================= AUTH LOGIC ================= */
document.getElementById("googleLoginBtn").onclick = async () => {
  try {
    await auth.signInWithPopup(googleProvider);
  } catch (e) {
    alert("Login failed: " + e.message);
  }
};

document.getElementById("logoutBtn").onclick = async () => {
  if (confirm("Sign out karna chahte hain?")) await auth.signOut();
};

auth.onAuthStateChanged(user => {
  if (user) {
    currentUser = user;
    document.getElementById("loginScreen").classList.add("hidden");
    document.getElementById("appShell").classList.remove("hidden");
    document.getElementById("userName").textContent = user.displayName || user.email;
    document.getElementById("userAvatar").src = user.photoURL || "";
  } else {
    currentUser = null;
    document.getElementById("loginScreen").classList.remove("hidden");
    document.getElementById("appShell").classList.add("hidden");
  }
});

/* ================= SETUP & STATE ================= */
const canvas = document.getElementById("pdfCanvas");
const ctx = canvas.getContext("2d");
const container = document.getElementById("canvasContainer");

const ocrCanvas = document.createElement("canvas");
const ocrCtx = ocrCanvas.getContext("2d");

let pdfDoc = null;
let pageNum = 1;
let fileHash = null;
let pdfScale = "fit";
let currentRenderTask = null;

// Quiz State
let currentQuizData = [];
let currentQuestionIndex = 0;
let userScore = 0;

// In-memory store (Firestore ka local cache)
let pdfStore = {};

/* ================= FIRESTORE HELPERS ================= */
function getDocId(hash) {
  return `${currentUser.uid}_${hash}`;
}

async function loadStoreFromFirestore(hash) {
  try {
    const snap = await db.collection("smartPrep").doc(getDocId(hash)).get();
    if (snap.exists) {
      pdfStore[hash] = snap.data();
    } else {
      pdfStore[hash] = { ocr: {}, summary: {}, explain: {} };
    }
  } catch (e) {
    console.error("Firestore load error:", e);
    pdfStore[hash] = { ocr: {}, summary: {}, explain: {} };
  }
}

async function saveToFirestore(hash) {
  if (!currentUser) return;
  try {
    await db.collection("smartPrep").doc(getDocId(hash)).set(pdfStore[hash]);
  } catch (e) {
    console.error("Firestore save error:", e);
  }
}

/* ================= UTILS ================= */
async function hashFile(buf) {
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, "0")).join("");
}

function showLoading(id, msg) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = `<div style="text-align:center; color:#666; margin-top:10px;">⏳ ${msg}</div>`;
}

function updateOCRStatus(p, status) {
  if (p === pageNum || status.includes("All")) {
    const el = document.getElementById("ocrStatus");
    if (el) {
      el.textContent = `P${p}: ${status}`;
      if (status.includes("Done")) { el.style.background = "#dcfce7"; el.style.color = "#166534"; }
      else if (status.includes("Error")) { el.style.background = "#fee2e2"; el.style.color = "#991b1b"; }
      else { el.style.background = "#e0f2fe"; el.style.color = "#0284c7"; }
    }
  }
}

/* ================= ZOOM & RESIZE ================= */
const zoomSpan = document.getElementById("zoomLevel");
function getScale(viewport) {
  if (pdfScale === "fit") return (container.clientWidth - 60) / viewport.width;
  return pdfScale;
}
function updateZoomUI() { zoomSpan.textContent = pdfScale === "fit" ? "Fit" : `${Math.round(pdfScale * 100)}%`; }

document.getElementById("zoomInBtn").onclick = () => { if (pdfScale === "fit") pdfScale = 1.0; pdfScale += 0.25; renderPage(); };
document.getElementById("zoomOutBtn").onclick = () => { if (pdfScale === "fit") pdfScale = 1.0; if (pdfScale > 0.5) pdfScale -= 0.25; renderPage(); };
document.getElementById("fitWidthBtn").onclick = () => { pdfScale = "fit"; renderPage(); };

/* ================= PDF LOAD & RENDER ================= */
document.getElementById("pdfUpload").onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;

  const buf = await file.arrayBuffer();
  fileHash = await hashFile(buf);

  // Load from Firestore (ya fresh start)
  await loadStoreFromFirestore(fileHash);

  pdfDoc = await pdfjsLib.getDocument(buf).promise;
  pageNum = 1;

  document.getElementById("ocrStatus").textContent = "Loaded";
  renderPage();

  await runOCRPage(pageNum);
  setTimeout(runOCRBackground, 1000);
};

async function renderPage() {
  if (!pdfDoc) return;
  if (currentRenderTask) currentRenderTask.cancel();

  const page = await pdfDoc.getPage(pageNum);
  const unscaled = page.getViewport({ scale: 1.0 });
  const scale = getScale(unscaled);
  const viewport = page.getViewport({ scale });

  canvas.width = viewport.width;
  canvas.height = viewport.height;
  updateZoomUI();

  const renderContext = { canvasContext: ctx, viewport };
  currentRenderTask = page.render(renderContext);

  try { await currentRenderTask.promise; } catch (e) { return; }

  document.getElementById("pageInfo").textContent = `${pageNum} / ${pdfDoc.numPages}`;

  const store = pdfStore[fileHash];
  const summaryBox = document.getElementById("aiSummary");
  const explainBox = document.getElementById("aiExplain");
  const quizPageEl = document.getElementById("quizPageNum");
  if (quizPageEl) quizPageEl.innerText = pageNum;

  if (store.summary[pageNum]) summaryBox.innerHTML = store.summary[pageNum];
  else if (store.ocr[pageNum]) autoSummary();
  else summaryBox.innerHTML = `<span class="placeholder-text">Scanning text...</span>`;

  if (store.explain[pageNum]) explainBox.innerHTML = store.explain[pageNum];
  else explainBox.innerHTML = `<span class="placeholder-text">Click 'Explain Page'</span>`;
}

/* ================= OCR ================= */
async function runOCRPage(p) {
  const store = pdfStore[fileHash];
  if (store.ocr[p]) { updateOCRStatus(p, "Ready"); return; }

  updateOCRStatus(p, "Scanning...");
  try {
    const page = await pdfDoc.getPage(p);
    const viewport = page.getViewport({ scale: 2.5 });
    ocrCanvas.width = viewport.width;
    ocrCanvas.height = viewport.height;
    ocrCtx.fillStyle = "white";
    ocrCtx.fillRect(0, 0, ocrCanvas.width, ocrCanvas.height);
    await page.render({ canvasContext: ocrCtx, viewport }).promise;

    const img = ocrCanvas.toDataURL("image/jpeg", 0.7);
    const res = await Tesseract.recognize(img, "hin+eng");

    store.ocr[p] = (res.data.text || "").trim();
    await saveToFirestore(fileHash); // Firestore mein save karo
    updateOCRStatus(p, "Done");
    if (p === pageNum) autoSummary();
  } catch (e) {
    console.error(e);
    updateOCRStatus(p, "Error");
  }
}

async function runOCRBackground() {
  const store = pdfStore[fileHash];
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    if (!store.ocr[i]) {
      if (i !== pageNum) updateOCRStatus(i, "BG Scan");
      await runOCRPage(i);
      await new Promise(r => setTimeout(r, 500));
    }
  }
  updateOCRStatus(0, "All Done");
}

/* ================= LANGUAGE & AI HELPER ================= */
function getSelectedLanguage() {
  const selector = document.getElementById("languageSelect");
  return selector ? selector.value : "hindi";
}

async function fetchAI(mode, text, question = "", language = "hindi") {
  try {
    // Vercel serverless function — relative path
    const res = await fetch("/api/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, text, question, language })
    });
    const d = await res.json();
    return d.reply;
  } catch (e) {
    return null;
  }
}

function formatText(t) {
  if (!t) return "";
  return t.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>")
    .replace(/- /g, "<br>• ")
    .replace(/\n/g, "<br>");
}

/* ================= AI FEATURES ================= */
async function autoSummary() {
  const store = pdfStore[fileHash];
  if (store.summary[pageNum] || !store.ocr[pageNum]) return;
  showLoading("aiSummary", "Summarizing...");

  const data = await fetchAI("summary", store.ocr[pageNum], "", getSelectedLanguage());
  if (data) {
    store.summary[pageNum] = formatText(data);
    await saveToFirestore(fileHash);
    document.getElementById("aiSummary").innerHTML = store.summary[pageNum];
  }
}

document.getElementById("aiExplainBtn").onclick = async () => {
  const store = pdfStore[fileHash];
  if (!store.ocr[pageNum]) return alert("Wait for OCR scan to finish.");
  showLoading("aiExplain", "Thinking...");

  const data = await fetchAI("explain", store.ocr[pageNum], "", getSelectedLanguage());
  if (data) {
    store.explain[pageNum] = formatText(data);
    await saveToFirestore(fileHash);
    document.getElementById("aiExplain").innerHTML = store.explain[pageNum];
  }
};

/* ================= QUIZ LOGIC ================= */
document.getElementById("generateQuizBtn").onclick = async () => {
  const store = pdfStore[fileHash];
  const text = store.ocr[pageNum];

  if (!text || text.length < 50) return alert("Page text too short or not scanned yet.");

  document.getElementById("quizPlaceholder").classList.add("hidden");
  document.getElementById("quizContent").classList.add("hidden");
  document.getElementById("quizLoading").style.display = "block";
  userScore = 0;
  document.getElementById("scoreValue").innerText = "0";

  const response = await fetchAI("quiz", text, "", getSelectedLanguage());
  document.getElementById("quizLoading").style.display = "none";

  try {
    const jsonStr = response.replace(/```json/g, "").replace(/```/g, "").trim();
    currentQuizData = JSON.parse(jsonStr);
    if (currentQuizData.length > 0) {
      currentQuestionIndex = 0;
      document.getElementById("quizContent").classList.remove("hidden");
      renderQuestion();
    } else {
      alert("AI couldn't generate questions. Try another page.");
    }
  } catch (e) {
    console.error("JSON Error", e);
    alert("Error parsing quiz data.");
  }
};

function renderQuestion() {
  const q = currentQuizData[currentQuestionIndex];
  document.getElementById("questionText").innerText = `${currentQuestionIndex + 1}. ${q.question}`;

  const optContainer = document.getElementById("optionsContainer");
  optContainer.innerHTML = "";
  document.getElementById("quizFeedback").classList.add("hidden");
  document.getElementById("nextQuestionBtn").classList.add("hidden");

  q.options.forEach((opt, idx) => {
    const btn = document.createElement("div");
    btn.className = "option-btn";
    btn.innerText = opt;
    btn.onclick = () => checkAnswer(idx, btn);
    optContainer.appendChild(btn);
  });
}

function checkAnswer(selectedIndex, btnElement) {
  const q = currentQuizData[currentQuestionIndex];
  const options = document.querySelectorAll(".option-btn");

  options.forEach(opt => opt.classList.add("disabled"));

  const isCorrect = q.options[selectedIndex] === q.answer || q.answer.includes(q.options[selectedIndex]);

  if (isCorrect) {
    btnElement.classList.add("correct");
    userScore++;
    document.getElementById("scoreValue").innerText = userScore;
    showFeedback(true, q.explanation);
  } else {
    btnElement.classList.add("wrong");
    options.forEach(opt => {
      if (opt.innerText === q.answer || q.answer.includes(opt.innerText)) {
        opt.classList.add("correct");
      }
    });
    showFeedback(false, q.explanation);
  }
  document.getElementById("nextQuestionBtn").classList.remove("hidden");
}

function showFeedback(isCorrect, text) {
  const box = document.getElementById("quizFeedback");
  box.classList.remove("hidden");
  box.innerHTML = `<strong>${isCorrect ? "✅ Correct!" : "❌ Incorrect"}</strong><br>${text}`;
}

document.getElementById("nextQuestionBtn").onclick = () => {
  if (currentQuestionIndex < currentQuizData.length - 1) {
    currentQuestionIndex++;
    renderQuestion();
  } else {
    alert(`Quiz Finished! Final Score: ${userScore}/${currentQuizData.length}`);
    document.getElementById("quizContent").classList.add("hidden");
    document.getElementById("quizPlaceholder").classList.remove("hidden");
    document.getElementById("scoreValue").innerText = "0";
  }
};

/* ================= CHAT LOGIC ================= */
function addMsg(role, txt) {
  const div = document.createElement("div");
  const id = "m-" + Date.now();
  div.id = id;
  div.className = `chat-bubble ${role}`;
  div.innerHTML = txt;
  const msgContainer = document.getElementById("chatMessages");
  msgContainer.appendChild(div);
  msgContainer.scrollTop = msgContainer.scrollHeight;
  return id;
}

document.getElementById("sendChatBtn").onclick = async () => {
  const input = document.getElementById("chatInput");
  const q = input.value.trim();
  if (!q) return;
  input.value = "";
  addMsg("user", q);
  const tempId = addMsg("assistant", "Thinking...");

  const store = pdfStore[fileHash];
  const context = store.ocr[pageNum] || "No text scanned.";
  const data = await fetchAI("chat", context, q, getSelectedLanguage());
  document.getElementById(tempId).innerHTML = formatText(data || "AI connection error.");
};

document.getElementById("chatInput").addEventListener("keypress", e => {
  if (e.key === "Enter") document.getElementById("sendChatBtn").click();
});

/* ================= NAV BUTTONS ================= */
document.getElementById("prevBtn").onclick = () => { if (pageNum > 1) { pageNum--; renderPage(); } };
document.getElementById("nextBtn").onclick = () => { if (pageNum < pdfDoc.numPages) { pageNum++; renderPage(); } };

document.getElementById("resetBtn").onclick = async () => {
  if (confirm("Is PDF ka saved data delete karna chahte hain?")) {
    if (fileHash && currentUser) {
      await db.collection("smartPrep").doc(getDocId(fileHash)).delete();
      pdfStore[fileHash] = { ocr: {}, summary: {}, explain: {} };
      renderPage();
    }
  }
};

document.getElementById("pdfChatIcon").onclick = () => document.getElementById("aiChatPanel").classList.add("open");
document.getElementById("closeChatBtn").onclick = () => document.getElementById("aiChatPanel").classList.remove("open");
