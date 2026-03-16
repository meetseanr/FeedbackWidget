/**
 * Build AU — Prototype Feedback Widget v2
 * ────────────────────────────────────────
 * Drop into any prototype with a single <script> tag:
 *   <script src="feedback-widget.js"></script>
 *
 * SETUP: Fill in the three config values below.
 * See feedback-setup.md for Supabase setup instructions.
 *
 * NEW IN v2:
 *  - Screenshot captured at pin time (cropped to pin area, stored in DB)
 *  - Element context captured (what UI element was clicked)
 *  - Review panel shows screenshot thumbnails
 *  - "Export for Claude" generates a paste-ready summary Sean can share
 *    directly in the Claude conversation for AI-assisted review
 */

(function () {
  'use strict';

  // ═══════════════════════════════════════════════
  //  CONFIGURATION — fill these in
  // ═══════════════════════════════════════════════
  const SUPABASE_URL      = 'https://yurruhkpcwhfmlhvawqr.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl1cnJ1aGtwY3doZm1saHZhd3FyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1OTgxMTcsImV4cCI6MjA4OTE3NDExN30.SCFBSyUDCV_K7L9FsMicioCd5E5-WgTKxFd7ItxjOEI';
  const ADMIN_PASSWORD    = 'B3tterSoftware2026!';        // reviewer password
  // ═══════════════════════════════════════════════

  const PROTOTYPE_ID   = window.location.hostname + window.location.pathname;
  const PROTOTYPE_NAME = document.title || PROTOTYPE_ID;

  let pins           = [];
  let annotationMode = false;

  // ─── Supabase API ─────────────────────────────────────────────────────────

  const apiHeaders = () => ({
    'apikey':        SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type':  'application/json',
  });

  async function apiFetchPins() {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/feedback_pins?prototype_id=eq.${encodeURIComponent(PROTOTYPE_ID)}&order=created_at.asc`,
      { headers: apiHeaders() }
    );
    return res.ok ? res.json() : [];
  }

  async function apiSavePin(pin) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/feedback_pins`, {
      method:  'POST',
      headers: { ...apiHeaders(), 'Prefer': 'return=representation' },
      body:    JSON.stringify(pin),
    });
    const data = await res.json();
    return data[0];
  }

  async function apiDeletePin(id) {
    await fetch(`${SUPABASE_URL}/rest/v1/feedback_pins?id=eq.${id}`, {
      method:  'DELETE',
      headers: apiHeaders(),
    });
  }

  // ─── Screenshot capture ───────────────────────────────────────────────────
  // Uses html2canvas (loaded on demand). Captures the viewport, crops to a
  // 420×280 region centred on the pin, draws a pin marker overlay, returns
  // a JPEG data-URL (~8–20 KB at the quality setting used).

  let html2canvasReady = false;

  function loadHtml2Canvas() {
    return new Promise((resolve, reject) => {
      if (window.html2canvas) { resolve(); return; }
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
      s.onload  = () => { html2canvasReady = true; resolve(); };
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function captureScreenshot(xPct, yPct) {
    try {
      await loadHtml2Canvas();

      // Hide widget chrome before capture
      const toHide = ['fb-overlay', 'fb-banner', 'fb-btn-feedback', 'fb-btn-review']
        .map(id => document.getElementById(id)).filter(Boolean);
      toHide.forEach(el => { el.style.visibility = 'hidden'; });

      const full = await window.html2canvas(document.documentElement, {
        scale:      0.6,
        useCORS:    true,
        logging:    false,
        windowWidth:  window.innerWidth,
        windowHeight: window.innerHeight,
        scrollX:    -window.scrollX,
        scrollY:    -window.scrollY,
      });

      toHide.forEach(el => { el.style.visibility = ''; });

      // Crop around pin
      const CROP_W = 420, CROP_H = 280;
      const pinX   = (xPct / 100) * full.width;
      const pinY   = (yPct / 100) * full.height;
      const sx     = Math.max(0, Math.min(pinX - CROP_W / 2, full.width  - CROP_W));
      const sy     = Math.max(0, Math.min(pinY - CROP_H / 2, full.height - CROP_H));

      const crop = document.createElement('canvas');
      crop.width  = CROP_W;
      crop.height = CROP_H;
      const ctx = crop.getContext('2d');
      ctx.drawImage(full, sx, sy, CROP_W, CROP_H, 0, 0, CROP_W, CROP_H);

      // Draw crosshair + pin dot
      const dotX = pinX - sx;
      const dotY = pinY - sy;
      ctx.strokeStyle = 'rgba(99,102,241,0.5)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(dotX, 0); ctx.lineTo(dotX, CROP_H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, dotY); ctx.lineTo(CROP_W, dotY); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(dotX, dotY, 9, 0, Math.PI * 2);
      ctx.fillStyle = '#6366f1';
      ctx.fill();
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 2;
      ctx.stroke();

      return crop.toDataURL('image/jpeg', 0.45);
    } catch (err) {
      console.warn('[FeedbackWidget] Screenshot failed:', err);
      return null;
    }
  }

  // ─── Element context ─────────────────────────────────────────────────────
  // Briefly disables the overlay pointer-events to hit-test the underlying UI,
  // then extracts a short human-readable description of what was clicked.

  function captureElementContext(cx, cy) {
    try {
      const overlay = document.getElementById('fb-overlay');
      overlay.style.pointerEvents = 'none';
      const el = document.elementFromPoint(cx, cy);
      overlay.style.pointerEvents = '';
      if (!el || el === document.body || el === document.documentElement) return null;

      const label = el.getAttribute('aria-label')
        || el.getAttribute('title')
        || el.getAttribute('placeholder')
        || null;
      const text = el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) || null;
      const tag  = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || null;

      // Walk up to find a meaningful ancestor label
      let ancestor = el.parentElement;
      let sectionLabel = null;
      for (let i = 0; i < 5 && ancestor; i++) {
        const h = ancestor.querySelector('h1,h2,h3,h4,h5,[class*="title"],[class*="header"],[class*="label"]');
        if (h && h.textContent.trim()) { sectionLabel = h.textContent.trim().slice(0, 50); break; }
        ancestor = ancestor.parentElement;
      }

      const parts = [];
      if (label)        parts.push(label);
      else if (text)    parts.push(`"${text}"`);
      if (role)         parts.push(`(${role})`);
      else              parts.push(`<${tag}>`);
      if (sectionLabel && sectionLabel !== text) parts.push(`in "${sectionLabel}"`);

      return parts.join(' ');
    } catch (e) {
      return null;
    }
  }

  // ─── Styles ───────────────────────────────────────────────────────────────

  function injectStyles() {
    const s = document.createElement('style');
    s.id = 'fb-styles';
    s.textContent = `
      .fb-w { box-sizing: border-box; font-family: -apple-system,'Inter',sans-serif; line-height:1.4; }
      .fb-w * { box-sizing: border-box; }

      /* Floating buttons */
      #fb-btn-feedback {
        position:fixed; bottom:24px; right:24px; z-index:10000;
        background:#6366f1; color:white; border:none; cursor:pointer;
        padding:10px 18px; border-radius:22px; font-size:13px; font-weight:600;
        box-shadow:0 4px 14px rgba(99,102,241,0.45);
        display:flex; align-items:center; gap:7px; transition:all 0.2s;
      }
      #fb-btn-feedback:hover { background:#4f46e5; transform:translateY(-1px); }
      #fb-btn-feedback.fb-cancel { background:#ef4444; box-shadow:0 4px 14px rgba(239,68,68,0.4); }

      #fb-btn-review {
        position:fixed; bottom:24px; right:170px; z-index:10000;
        background:white; color:#6366f1; border:1.5px solid #c7d2fe; cursor:pointer;
        padding:10px 16px; border-radius:22px; font-size:13px; font-weight:600;
        box-shadow:0 2px 8px rgba(0,0,0,0.08);
        display:none; align-items:center; gap:7px; transition:all 0.2s;
      }
      #fb-btn-review:hover { background:#eef2ff; }
      #fb-btn-review.visible { display:flex; }

      /* Annotation mode */
      #fb-overlay {
        position:fixed; inset:0; z-index:9980; cursor:crosshair;
        background:rgba(99,102,241,0.05); display:none;
      }
      #fb-overlay.on { display:block; }
      #fb-banner {
        position:fixed; top:0; left:0; right:0; z-index:9990;
        background:#6366f1; color:white; text-align:center;
        padding:10px 16px; font-size:13px; font-weight:500; display:none; pointer-events:none;
      }
      #fb-banner.on { display:block; }

      /* Pin markers */
      #fb-pin-layer { position:fixed; inset:0; pointer-events:none; z-index:9960; }
      .fb-pin {
        position:absolute; pointer-events:auto;
        width:28px; height:28px; cursor:pointer;
        transform:translate(-14px,-28px);
      }
      .fb-pin-circle {
        width:28px; height:28px; border-radius:50% 50% 50% 0;
        background:#6366f1; border:2px solid white;
        box-shadow:0 2px 8px rgba(99,102,241,0.5);
        display:flex; align-items:center; justify-content:center;
        transform:rotate(-45deg); transition:transform 0.15s;
        color:white; font-size:11px; font-weight:700;
      }
      .fb-pin:hover .fb-pin-circle { transform:rotate(-45deg) scale(1.2); }
      .fb-pin-num { transform:rotate(45deg); }

      /* Popups */
      .fb-popup {
        position:fixed; z-index:10010; width:300px;
        background:white; border-radius:12px;
        box-shadow:0 8px 28px rgba(0,0,0,0.14),0 2px 8px rgba(0,0,0,0.07);
        padding:16px; animation:fb-pop 0.15s ease;
      }
      @keyframes fb-pop { from{opacity:0;transform:scale(0.94)} to{opacity:1;transform:scale(1)} }
      .fb-popup h4 { font-size:12px; font-weight:700; color:#1d1d1f; margin:0 22px 10px 0; }
      .fb-popup-close {
        position:absolute; top:11px; right:11px;
        background:#f2f2f7; border:none; border-radius:50%;
        width:22px; height:22px; cursor:pointer; font-size:11px;
        color:#86868b; display:flex; align-items:center; justify-content:center;
      }
      .fb-popup-close:hover { background:#e5e5ea; }
      .fb-popup input, .fb-popup textarea {
        width:100%; border:1.5px solid #e5e5ea; border-radius:8px;
        padding:8px 10px; font-size:12px; color:#1d1d1f; outline:none;
        transition:border-color 0.15s; resize:none; font-family:inherit; display:block;
        margin-bottom:8px; background:white;
      }
      .fb-popup input:focus, .fb-popup textarea:focus { border-color:#6366f1; }
      .fb-popup textarea { height:84px; }
      .fb-popup-footer { display:flex; gap:8px; justify-content:flex-end; margin-top:2px; }
      .fb-btn { padding:7px 14px; border-radius:7px; font-size:12px; font-weight:600; cursor:pointer; border:none; }
      .fb-btn-cancel { background:#f2f2f7; color:#4a4a4c; }
      .fb-btn-cancel:hover { background:#e5e5ea; }
      .fb-btn-submit { background:#6366f1; color:white; }
      .fb-btn-submit:hover { background:#4f46e5; }
      .fb-btn-submit:disabled { opacity:0.6; cursor:not-allowed; }
      .fb-pin-timestamp { font-size:11px; color:#aeaeb2; margin-bottom:10px; }
      .fb-capturing { font-size:11px; color:#6366f1; text-align:center; padding:6px 0 2px; }

      /* Read-only popup */
      .fb-read-meta { font-size:10px; color:#aeaeb2; margin-bottom:6px; }
      .fb-read-text { font-size:12px; color:#1d1d1f; line-height:1.6; margin-bottom:8px; }
      .fb-read-context { font-size:10px; color:#6366f1; background:#eef2ff; padding:4px 8px; border-radius:5px; margin-bottom:8px; font-style:italic; }
      .fb-read-thumb { width:100%; border-radius:7px; border:1px solid #e5e5ea; display:block; }

      /* Review panel */
      #fb-panel {
        position:fixed; top:0; right:-440px; bottom:0; width:420px;
        z-index:10005; background:white;
        box-shadow:-4px 0 28px rgba(0,0,0,0.12);
        transition:right 0.3s cubic-bezier(0.4,0,0.2,1);
        display:flex; flex-direction:column;
      }
      #fb-panel.open { right:0; }
      .fb-panel-head {
        display:flex; align-items:center; justify-content:space-between;
        padding:16px 20px; border-bottom:1px solid #f0f0f2; flex-shrink:0;
      }
      .fb-panel-head h3 { font-size:15px; font-weight:700; color:#1d1d1f; display:flex; align-items:center; gap:8px; }
      .fb-count-chip { font-size:11px; font-weight:700; background:#eef2ff; color:#6366f1; padding:2px 8px; border-radius:10px; }
      .fb-panel-toolbar {
        padding:10px 20px; border-bottom:1px solid #f0f0f2; flex-shrink:0;
        display:flex; gap:8px;
      }
      .fb-panel-close {
        background:#f2f2f7; border:none; border-radius:7px;
        width:28px; height:28px; cursor:pointer; font-size:12px; color:#86868b;
        display:flex; align-items:center; justify-content:center;
      }
      .fb-panel-close:hover { background:#e5e5ea; }
      .fb-export-btn {
        flex:1; background:#f5f3ff; color:#6366f1; border:1.5px solid #c7d2fe;
        border-radius:8px; padding:8px 12px; font-size:12px; font-weight:600;
        cursor:pointer; display:flex; align-items:center; gap:6px; justify-content:center;
        transition:all 0.15s;
      }
      .fb-export-btn:hover { background:#ede9fe; }

      #fb-panel-list { flex:1; overflow-y:auto; }
      .fb-panel-empty { padding:48px 24px; text-align:center; color:#aeaeb2; font-size:13px; line-height:1.6; }
      .fb-panel-empty span { display:block; font-size:28px; margin-bottom:10px; }

      .fb-panel-item {
        padding:16px 20px; border-bottom:1px solid #f5f5f7;
        transition:background 0.1s;
      }
      .fb-panel-item:hover { background:#fafafa; }
      .fb-item-row { display:flex; gap:12px; align-items:flex-start; }
      .fb-panel-dot {
        width:26px; height:26px; border-radius:50%;
        background:#6366f1; color:white;
        font-size:11px; font-weight:700;
        display:flex; align-items:center; justify-content:center;
        flex-shrink:0; margin-top:1px;
      }
      .fb-panel-body { flex:1; min-width:0; }
      .fb-item-header { display:flex; align-items:baseline; gap:6px; margin-bottom:3px; }
      .fb-panel-author { font-size:12px; font-weight:600; color:#1d1d1f; }
      .fb-panel-date { font-size:10px; color:#aeaeb2; }
      .fb-panel-comment { font-size:12px; color:#4a4a4c; line-height:1.6; margin-bottom:6px; }
      .fb-panel-context { font-size:10px; color:#6366f1; background:#eef2ff; padding:3px 7px; border-radius:5px; margin-bottom:8px; display:inline-block; font-style:italic; }
      .fb-panel-thumb {
        width:100%; border-radius:8px; border:1px solid #e5e5ea;
        display:block; margin-bottom:8px; cursor:zoom-in;
      }
      .fb-panel-resolve {
        padding:4px 10px; border-radius:6px;
        font-size:10px; font-weight:700; cursor:pointer;
        border:1.5px solid #bbf7d0; color:#16a34a; background:none; transition:all 0.15s;
      }
      .fb-panel-resolve:hover { background:#f0fdf4; }

      /* Lightbox */
      #fb-lightbox {
        position:fixed; inset:0; background:rgba(0,0,0,0.8); z-index:10020;
        display:none; align-items:center; justify-content:center; cursor:zoom-out;
      }
      #fb-lightbox.open { display:flex; }
      #fb-lightbox img { max-width:90vw; max-height:88vh; border-radius:10px; }

      /* Admin gate */
      #fb-gate {
        position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:10008;
        display:none; align-items:center; justify-content:center; backdrop-filter:blur(2px);
      }
      #fb-gate.open { display:flex; }
      .fb-gate-card {
        background:white; border-radius:16px; padding:28px 28px 24px;
        width:340px; box-shadow:0 20px 48px rgba(0,0,0,0.18); animation:fb-pop 0.2s ease;
      }
      .fb-gate-card h3 { font-size:16px; font-weight:700; color:#1d1d1f; margin-bottom:4px; }
      .fb-gate-card p { font-size:12px; color:#86868b; margin-bottom:18px; line-height:1.5; }
      .fb-gate-card input {
        width:100%; border:1.5px solid #e5e5ea; border-radius:9px;
        padding:10px 13px; font-size:13px; outline:none;
        font-family:inherit; margin-bottom:6px; display:block;
      }
      .fb-gate-card input:focus { border-color:#6366f1; }
      .fb-gate-err { font-size:11px; color:#ef4444; min-height:16px; margin-bottom:10px; }
      .fb-gate-submit {
        width:100%; background:#6366f1; color:white; border:none;
        padding:11px; border-radius:9px; font-size:13px; font-weight:600; cursor:pointer;
      }
      .fb-gate-submit:hover { background:#4f46e5; }
      .fb-gate-cancel { display:block; text-align:center; margin-top:10px; font-size:11px; color:#aeaeb2; cursor:pointer; }

      /* Export modal */
      #fb-export-modal {
        position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:10015;
        display:none; align-items:center; justify-content:center; backdrop-filter:blur(2px);
      }
      #fb-export-modal.open { display:flex; }
      .fb-export-card {
        background:white; border-radius:16px; padding:0; width:560px; max-width:94vw;
        max-height:80vh; display:flex; flex-direction:column;
        box-shadow:0 20px 48px rgba(0,0,0,0.18); animation:fb-pop 0.2s ease;
      }
      .fb-export-head {
        display:flex; align-items:center; justify-content:space-between;
        padding:18px 22px 14px; border-bottom:1px solid #f0f0f2; flex-shrink:0;
      }
      .fb-export-head h3 { font-size:15px; font-weight:700; color:#1d1d1f; }
      .fb-export-body { flex:1; overflow-y:auto; padding:16px 22px; }
      .fb-export-body p { font-size:12px; color:#4a4a4c; line-height:1.65; margin-bottom:12px; }
      .fb-export-textarea {
        width:100%; height:180px; border:1.5px solid #e5e5ea; border-radius:9px;
        padding:10px 12px; font-size:11px; color:#1d1d1f; font-family:monospace;
        resize:none; outline:none; margin-bottom:12px;
      }
      .fb-export-textarea:focus { border-color:#6366f1; }
      .fb-export-foot {
        padding:12px 22px 18px; border-top:1px solid #f0f0f2;
        display:flex; gap:8px; justify-content:flex-end; flex-shrink:0;
      }
      .fb-copy-btn { background:#6366f1; color:white; border:none; padding:9px 18px; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer; }
      .fb-copy-btn:hover { background:#4f46e5; }
    `;
    document.head.appendChild(s);
  }

  // ─── HTML scaffold ────────────────────────────────────────────────────────

  function injectHTML() {
    document.body.insertAdjacentHTML('beforeend', `
      <div id="fb-banner" class="fb-w">📌 &nbsp;Click anywhere to place a feedback pin &nbsp;·&nbsp; Press <strong>Esc</strong> to cancel</div>
      <div id="fb-overlay" class="fb-w"></div>
      <div id="fb-pin-layer" class="fb-w"></div>

      <!-- Floating buttons -->
      <button id="fb-btn-feedback" class="fb-w">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        Feedback
      </button>
      <button id="fb-btn-review" class="fb-w">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        Review <span id="fb-badge"></span>
      </button>

      <!-- Review panel -->
      <div id="fb-panel" class="fb-w">
        <div class="fb-panel-head">
          <h3>Feedback <span class="fb-count-chip" id="fb-count">0</span></h3>
          <button class="fb-panel-close" onclick="document.getElementById('fb-panel').classList.remove('open')">✕</button>
        </div>
        <div class="fb-panel-toolbar">
          <button class="fb-export-btn" onclick="window._fbExport()">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Export for Claude review
          </button>
        </div>
        <div id="fb-panel-list"></div>
      </div>

      <!-- Lightbox -->
      <div id="fb-lightbox" class="fb-w" onclick="this.classList.remove('open')">
        <img id="fb-lightbox-img" src="" alt="Screenshot">
      </div>

      <!-- Admin password gate -->
      <div id="fb-gate" class="fb-w">
        <div class="fb-gate-card">
          <h3>Review feedback</h3>
          <p>Enter the reviewer password to manage feedback comments.</p>
          <input type="password" id="fb-gate-input" placeholder="Password"
            onkeydown="if(event.key==='Enter') window._fbCheckAdmin()">
          <div class="fb-gate-err" id="fb-gate-err"></div>
          <button class="fb-gate-submit" onclick="window._fbCheckAdmin()">Open review panel</button>
          <span class="fb-gate-cancel" onclick="document.getElementById('fb-gate').classList.remove('open')">Cancel</span>
        </div>
      </div>

      <!-- Export modal -->
      <div id="fb-export-modal" class="fb-w">
        <div class="fb-export-card">
          <div class="fb-export-head">
            <h3>Export for Claude review</h3>
            <button class="fb-panel-close" onclick="document.getElementById('fb-export-modal').classList.remove('open')">✕</button>
          </div>
          <div class="fb-export-body">
            <p>Copy the text below and paste it into your Claude conversation. Claude can read the comments and see the screenshot of exactly where each pin was placed.</p>
            <textarea class="fb-export-textarea" id="fb-export-text" readonly></textarea>
          </div>
          <div class="fb-export-foot">
            <button class="fb-btn fb-btn-cancel" onclick="document.getElementById('fb-export-modal').classList.remove('open')">Close</button>
            <button class="fb-copy-btn" onclick="window._fbCopyExport()">Copy to clipboard</button>
          </div>
        </div>
      </div>
    `);
  }

  // ─── Pin rendering ────────────────────────────────────────────────────────

  function renderPins() {
    const layer   = document.getElementById('fb-pin-layer');
    layer.innerHTML = '';
    const docW    = document.documentElement.scrollWidth;
    const docH    = document.documentElement.scrollHeight;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    pins.forEach((pin, i) => {
      // Convert document-relative percentages → current viewport percentages
      const pageX  = (pin.x_pct / 100) * docW;
      const pageY  = (pin.y_pct / 100) * docH;
      const viewXPct = ((pageX - scrollX) / window.innerWidth)  * 100;
      const viewYPct = ((pageY - scrollY) / window.innerHeight) * 100;

      const el       = document.createElement('div');
      el.className   = 'fb-pin fb-w';
      el.style.left  = viewXPct + '%';
      el.style.top   = viewYPct + '%';
      el.innerHTML   = `<div class="fb-pin-circle"><span class="fb-pin-num">${i + 1}</span></div>`;
      el.onclick     = (e) => { e.stopPropagation(); showReadPopup(pin, i + 1, e.clientX, e.clientY); };
      layer.appendChild(el);
    });
  }

  function updateCounts() {
    const n = pins.length;
    document.getElementById('fb-count').textContent = n;
    document.getElementById('fb-badge').textContent = n ? `(${n})` : '';
    document.getElementById('fb-btn-review').classList.toggle('visible', n > 0);
  }

  // ─── Popups ───────────────────────────────────────────────────────────────

  function closeAllPopups() {
    document.querySelectorAll('.fb-popup').forEach(p => p.remove());
  }

  function showReadPopup(pin, num, cx, cy) {
    closeAllPopups();
    const d       = new Date(pin.created_at);
    const dateStr = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' +
      d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });

    const p = document.createElement('div');
    p.className = 'fb-popup fb-w';
    p.innerHTML = `
      <button class="fb-popup-close" onclick="this.closest('.fb-popup').remove()">✕</button>
      <h4>Pin ${num}</h4>
      <div class="fb-read-meta">${escHtml(pin.author_name || 'Anonymous')} · ${dateStr}</div>
      ${pin.element_context ? `<div class="fb-read-context">📍 ${escHtml(pin.element_context)}</div>` : ''}
      <div class="fb-read-text">${escHtml(pin.comment)}</div>
      ${pin.screenshot ? `<img class="fb-read-thumb" src="${pin.screenshot}" alt="Screenshot" onclick="window._fbLightbox('${pin.screenshot}')">` : ''}
    `;
    placePopup(p, cx, cy);
  }

  function showCommentForm(xPctDoc, yPctDoc, xPctVp, yPctVp, cx, cy, elementContext) {
    closeAllPopups();

    // Capture timestamp at the moment the pin is placed
    const pinnedAt    = new Date();
    const pinnedAtISO = pinnedAt.toISOString();
    const pinnedAtDisplay = pinnedAt.toLocaleDateString('en-AU', {
      day: 'numeric', month: 'short', year: 'numeric'
    }) + ' · ' + pinnedAt.toLocaleTimeString('en-AU', {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });

    const p = document.createElement('div');
    p.className = 'fb-popup fb-w';
    p.innerHTML = `
      <h4>Add feedback</h4>
      <div class="fb-pin-timestamp">📅 ${pinnedAtDisplay}</div>
      <input type="text" id="fb-inp-name" placeholder="Your name (optional)">
      <textarea id="fb-inp-comment" placeholder="Describe the issue or your feedback…"></textarea>
      <div class="fb-capturing" id="fb-cap-status"></div>
      <div class="fb-popup-footer">
        <button class="fb-btn fb-btn-cancel" id="fb-inp-cancel">Cancel</button>
        <button class="fb-btn fb-btn-submit" id="fb-inp-submit">Post pin</button>
      </div>
    `;
    // Centre in viewport
    p.style.left      = '50%';
    p.style.top       = '50%';
    p.style.transform = 'translate(-50%, -50%)';
    document.body.appendChild(p);
    document.getElementById('fb-inp-comment').focus();

    // Start screenshot capture in background while user types
    let screenshotData = null;
    const capStatus = document.getElementById('fb-cap-status');
    capStatus.textContent = '⏳ Capturing screenshot…';
    captureScreenshot(xPctVp, yPctVp).then(data => {
      screenshotData = data;
      capStatus.textContent = data ? '✓ Screenshot captured' : '';
      setTimeout(() => { if (capStatus) capStatus.textContent = ''; }, 1500);
    });

    document.getElementById('fb-inp-cancel').onclick = () => { p.remove(); exitAnnotationMode(); };

    document.getElementById('fb-inp-submit').onclick = async () => {
      const comment = document.getElementById('fb-inp-comment').value.trim();
      const name    = document.getElementById('fb-inp-name').value.trim();
      if (!comment) {
        document.getElementById('fb-inp-comment').style.borderColor = '#ef4444';
        return;
      }
      const btn = document.getElementById('fb-inp-submit');
      btn.textContent = 'Posting…'; btn.disabled = true;
      try {
        const saved = await apiSavePin({
          prototype_id:    PROTOTYPE_ID,
          x_pct:           xPctDoc,
          y_pct:           yPctDoc,
          comment,
          author_name:     name || 'Anonymous',
          element_context: elementContext || null,
          screenshot:      screenshotData || null,
          created_at:      pinnedAtISO,
        });
        pins.push(saved);
        renderPins();
        updateCounts();
        p.remove();
        exitAnnotationMode();
        toast('✓ Feedback posted — thank you!');
      } catch (err) {
        btn.textContent = 'Post pin'; btn.disabled = false;
        console.error('[FeedbackWidget] Save failed:', err);
      }
    };

    // Dismiss on outside click
    setTimeout(() => {
      document.addEventListener('mousedown', function dismiss(e) {
        if (!p.contains(e.target)) { p.remove(); document.removeEventListener('mousedown', dismiss); }
      });
    }, 100);
  }

  function placePopup(el, cx, cy) {
    document.body.appendChild(el);
    if (cx !== undefined) {
      el.style.left = Math.min(cx + 12, window.innerWidth  - 316) + 'px';
      el.style.top  = Math.min(cy + 12, window.innerHeight - 260) + 'px';
    }
    setTimeout(() => {
      document.addEventListener('mousedown', function dismiss(e) {
        if (!el.contains(e.target)) { el.remove(); document.removeEventListener('mousedown', dismiss); }
      });
    }, 100);
  }

  // ─── Lightbox ─────────────────────────────────────────────────────────────

  window._fbLightbox = function (src) {
    document.getElementById('fb-lightbox-img').src = src;
    document.getElementById('fb-lightbox').classList.add('open');
  };

  // ─── Annotation mode ──────────────────────────────────────────────────────

  function enterAnnotationMode() {
    annotationMode = true;
    document.getElementById('fb-overlay').classList.add('on');
    document.getElementById('fb-banner').classList.add('on');
    const btn = document.getElementById('fb-btn-feedback');
    btn.classList.add('fb-cancel');
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Cancel`;
    closeAllPopups();
  }

  function exitAnnotationMode() {
    annotationMode = false;
    document.getElementById('fb-overlay').classList.remove('on');
    document.getElementById('fb-banner').classList.remove('on');
    const btn = document.getElementById('fb-btn-feedback');
    btn.classList.remove('fb-cancel');
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> Feedback`;
  }

  // ─── Review panel ─────────────────────────────────────────────────────────

  function renderReviewPanel() {
    const list = document.getElementById('fb-panel-list');
    document.getElementById('fb-count').textContent = pins.length;
    if (!pins.length) {
      list.innerHTML = `<div class="fb-panel-empty"><span>💬</span>No feedback yet.<br>Share the prototype URL and ask reviewers to click <strong>Feedback</strong>.</div>`;
      return;
    }
    list.innerHTML = pins.map((pin, i) => {
      const d = new Date(pin.created_at);
      const dateStr = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) + ' ' +
        d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
      const thumb = pin.screenshot
        ? `<img class="fb-panel-thumb" src="${pin.screenshot}" alt="Pin ${i+1} screenshot" onclick="window._fbLightbox('${pin.screenshot}')">`
        : '';
      const ctx = pin.element_context
        ? `<span class="fb-panel-context">📍 ${escHtml(pin.element_context)}</span><br>`
        : '';
      return `
        <div class="fb-panel-item" id="fbi-${pin.id}">
          <div class="fb-item-row">
            <div class="fb-panel-dot">${i + 1}</div>
            <div class="fb-panel-body">
              <div class="fb-item-header">
                <span class="fb-panel-author">${escHtml(pin.author_name || 'Anonymous')}</span>
                <span class="fb-panel-date">${dateStr}</span>
              </div>
              ${ctx}
              <div class="fb-panel-comment">${escHtml(pin.comment)}</div>
              ${thumb}
              <button class="fb-panel-resolve" onclick="window._fbResolve('${pin.id}')">✓ Resolved — delete</button>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  // ─── Export for Claude ────────────────────────────────────────────────────
  // Generates a structured text block with embedded base64 screenshots.
  // When pasted into a Claude conversation, Claude can read the comments
  // AND visually inspect the screenshots to see exactly what was clicked.

  window._fbExport = function () {
    if (!pins.length) {
      toast('No feedback to export yet.');
      return;
    }

    const header = `# Prototype Feedback — ${PROTOTYPE_NAME}\nExported: ${new Date().toLocaleString('en-AU')}\nPrototype: ${PROTOTYPE_ID}\nTotal pins: ${pins.length}\n\n---\n\n`;

    const body = pins.map((pin, i) => {
      const d = new Date(pin.created_at);
      const dateStr = d.toLocaleString('en-AU');
      const lines = [
        `## Pin ${i + 1}`,
        `**Reviewer:** ${pin.author_name || 'Anonymous'}`,
        `**Date:** ${dateStr}`,
        `**Comment:** ${pin.comment}`,
      ];
      if (pin.element_context) {
        lines.push(`**Location context:** ${pin.element_context}`);
      }
      lines.push(`**Position:** x=${pin.x_pct.toFixed(1)}%, y=${pin.y_pct.toFixed(1)}%`);
      if (pin.screenshot) {
        lines.push(`**Screenshot:** ![Pin ${i+1} screenshot](${pin.screenshot})`);
      }
      return lines.join('\n');
    }).join('\n\n---\n\n');

    const instructions = `\n\n---\n\n*Please review the feedback above. For each pin, the screenshot shows the exact area of the prototype the reviewer was looking at when they left their comment. Please summarise the issues, identify themes, and suggest priorities.*`;

    const full = header + body + instructions;
    document.getElementById('fb-export-text').value = full;
    document.getElementById('fb-export-modal').classList.add('open');
  };

  window._fbCopyExport = function () {
    const ta = document.getElementById('fb-export-text');
    ta.select();
    navigator.clipboard.writeText(ta.value).then(() => {
      toast('✓ Copied — paste it into Claude');
    }).catch(() => {
      document.execCommand('copy');
      toast('✓ Copied — paste it into Claude');
    });
  };

  // ─── Admin gate ───────────────────────────────────────────────────────────

  window._fbCheckAdmin = function () {
    const val = document.getElementById('fb-gate-input').value;
    const err = document.getElementById('fb-gate-err');
    if (val === ADMIN_PASSWORD) {
      document.getElementById('fb-gate').classList.remove('open');
      document.getElementById('fb-gate-input').value = '';
      renderReviewPanel();
      document.getElementById('fb-panel').classList.add('open');
    } else {
      err.textContent = 'Incorrect password — try again';
      document.getElementById('fb-gate-input').value = '';
      document.getElementById('fb-gate-input').focus();
    }
  };

  window._fbResolve = async function (id) {
    const el = document.getElementById('fbi-' + id);
    if (el) { el.style.opacity = '0.4'; el.style.pointerEvents = 'none'; }
    try {
      await apiDeletePin(id);
      pins = pins.filter(p => p.id !== id);
      renderPins();
      updateCounts();
      renderReviewPanel();
    } catch (e) {
      if (el) { el.style.opacity = ''; el.style.pointerEvents = ''; }
      console.error('[FeedbackWidget] Delete failed:', e);
    }
  };

  // ─── Toast ────────────────────────────────────────────────────────────────

  function toast(msg) {
    const t = document.createElement('div');
    Object.assign(t.style, {
      position: 'fixed', bottom: '80px', left: '50%', transform: 'translateX(-50%)',
      background: '#1d1d1f', color: 'white', padding: '10px 18px',
      borderRadius: '20px', fontSize: '13px', fontWeight: '500', zIndex: '10020',
      boxShadow: '0 4px 12px rgba(0,0,0,0.25)', transition: 'opacity 0.4s',
      fontFamily: "-apple-system,'Inter',sans-serif", whiteSpace: 'nowrap',
    });
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 2400);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function escHtml(str) {
    return String(str)
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;');
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────

  function boot() {
    injectStyles();
    injectHTML();

    document.getElementById('fb-overlay').addEventListener('click', (e) => {
      if (!annotationMode) return;
      // Store as % of full document so pins survive scroll and viewport changes
      const xPctDoc = parseFloat(((e.pageX / document.documentElement.scrollWidth)  * 100).toFixed(3));
      const yPctDoc = parseFloat(((e.pageY / document.documentElement.scrollHeight) * 100).toFixed(3));
      // Viewport % used only for screenshot crop
      const xPctVp  = parseFloat(((e.clientX / window.innerWidth)  * 100).toFixed(3));
      const yPctVp  = parseFloat(((e.clientY / window.innerHeight) * 100).toFixed(3));
      const context = captureElementContext(e.clientX, e.clientY);
      exitAnnotationMode();
      showCommentForm(xPctDoc, yPctDoc, xPctVp, yPctVp, e.clientX, e.clientY, context);
    });

    // Re-render pins on scroll and resize so they track document positions
    let renderRaf = null;
    function scheduleRender() {
      if (renderRaf) return;
      renderRaf = requestAnimationFrame(() => { renderRaf = null; renderPins(); });
    }
    window.addEventListener('scroll', scheduleRender, { passive: true });
    window.addEventListener('resize', scheduleRender);

    document.getElementById('fb-btn-feedback').addEventListener('click', () => {
      annotationMode ? exitAnnotationMode() : enterAnnotationMode();
    });

    document.getElementById('fb-btn-review').addEventListener('click', () => {
      document.getElementById('fb-gate').classList.add('open');
      setTimeout(() => document.getElementById('fb-gate-input').focus(), 60);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (annotationMode) exitAnnotationMode();
        closeAllPopups();
        document.getElementById('fb-lightbox').classList.remove('open');
      }
    });

    if (SUPABASE_URL !== 'YOUR_SUPABASE_URL') {
      apiFetchPins()
        .then(data => { pins = data || []; renderPins(); updateCounts(); })
        .catch(err  => console.warn('[FeedbackWidget] Could not load pins:', err));
    } else {
      console.warn('[FeedbackWidget] Configure SUPABASE_URL and SUPABASE_ANON_KEY before deploying.');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
