/*
 * Отчёт в формате презентации.
 * Кнопка «Отчёт в формате презентации» на вкладке «Аналитика» открывает слайды
 * по текущему периоду отчёта: просмотр (стрелки ← →), скачивание PowerPoint (.pptx)
 * и печать / сохранение в PDF.
 */
(function () {
  "use strict";
  var PPTX_URL = "https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js";
  var MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
  var MSHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  var ROWS_PER_SLIDE = 9;
  var C = { accent: "1D3D6B", ink: "18202C", muted: "5B6678", line: "DDE2EA", soft: "E6ECF5", inc: "B8650F", out: "1F6FB8", ok: "1D7A4A" };

  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]; }); }
  function num(v) { var n = Number(v); return (v === "" || v == null || !isFinite(n)) ? 0 : n; }
  function money(n) { return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(num(n)) + " ₸"; }
  function pct(a, b) { return b ? Math.round(a * 1000 / b) / 10 + " %" : "—"; }
  function cell(x) { return (x && typeof x === "object") ? (x.text != null ? x.text : "") : (x == null ? "" : String(x)); }
  function sum(list) { return list.reduce(function (s, c) { return s + num(c.claimAmount); }, 0); }
  function chunk(rows, n) { var out = []; for (var i = 0; i < rows.length; i += n) out.push(rows.slice(i, i + n)); return out.length ? out : [[]]; }

  /* ---------- модель слайдов (общая для просмотра и .pptx) ---------- */
  function buildSlides(r) {
    var decN = r.decided.length;
    var slides = [];
    slides.push({ type: "title", title: "Отчёт о претензионно-исковой работе", sub: r.p.label.replace(/^за /, "Период: "),
      note: "Сформирован " + new Date().toLocaleDateString("ru-RU") });
    slides.push({ type: "kpi", title: "Ключевые показатели", items: [
      { k: "Поступило входящих исков", v: String(r.filedIn.length), s: "на сумму " + money(sum(r.filedIn)), c: C.inc },
      { k: "Подано исходящих исков", v: String(r.filedOut.length), s: "на сумму " + money(sum(r.filedOut)), c: C.out },
      { k: "Рассмотрено дел", v: String(decN), s: "в пользу компании: " + pct(r.oAll.fav, decN), c: C.ok },
      { k: "Присуждено с компании", v: money(r.awardedIn), s: "из заявленных " + money(r.claimedIn), c: C.accent },
      { k: "Присуждено в пользу компании", v: money(r.awardedOut), s: "из заявленных " + money(r.claimedOut), c: C.accent },
      { k: "Заседаний за период", v: String(r.hearings), s: "в работе сейчас: " + r.activeIn + " вх. / " + r.activeOut + " исх.", c: C.accent }
    ] });
    slides.push({ type: "text", title: "Итоги", items: r.summary.slice() });
    slides.push({ type: "chart", title: "Поступление дел по месяцам", months: r.months });
    function tableSlides(title, head, rows, foot, numCols) {
      var parts = chunk(rows, ROWS_PER_SLIDE);
      parts.forEach(function (part, i) {
        slides.push({ type: "table", title: title + (i ? " (продолжение)" : ""), head: head.map(cell),
          rows: part.map(function (row) { return row.map(cell); }),
          foot: (i === parts.length - 1 && foot) ? foot.map(cell) : null, numCols: numCols });
      });
    }
    tableSlides("Исходы рассмотренных дел", r.outHead, r.outRows, r.outFoot, [1, 2, 3, 4, 5, 6]);
    tableSlides("Денежные показатели", r.moneyHead, r.moneyRows, null, [1, 2]);
    tableSlides("По категориям споров", r.catHead, r.catRows, null, [1, 2, 3, 4, 5]);
    tableSlides("Страховые выплаты и уведомления", r.insHead, r.insRows, null, [1]);
    tableSlides("По ответственным работникам", r.respHead, r.respRows, null, [1, 2, 3, 4, 5, 6]);
    return slides;
  }

  /* ---------- просмотр в браузере ---------- */
  var css = [
    ".deck-ov{position:fixed;inset:0;z-index:40;background:#0f1520;display:flex;flex-direction:column;align-items:center;padding:12px;gap:10px}",
    ".deck-ov[hidden]{display:none}",
    ".deck-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:center;color:#fff;font-size:14px}",
    ".deck-bar .btn{background:#fff;color:#18202c;border-color:#fff}",
    ".deck-bar .btn.primary{background:#8fb3e6;border-color:#8fb3e6}",
    ".deck-msg{color:#fbe6a6;font-size:13px;min-height:1em;text-align:center}",
    ".deck-stage{flex:1;min-height:0;width:100%;display:flex;align-items:center;justify-content:center}",
    ".slide{container-type:inline-size;aspect-ratio:16/9;width:min(100%,calc((100vh - 140px)*16/9));background:#fff;color:#18202c;border-radius:6px;box-shadow:0 20px 50px rgba(0,0,0,.35);position:relative;overflow:hidden;font-family:'IBM Plex Sans','Segoe UI',Arial,sans-serif;display:none}",
    ".slide.on{display:block}",
    ".slide .in{position:absolute;inset:0;padding:4.2cqw 5cqw 5.5cqw;display:flex;flex-direction:column;gap:2cqw}",
    ".slide h2{font-family:'IBM Plex Serif',Georgia,serif;color:#1d3d6b;font-size:3.1cqw;margin:0;padding-bottom:1.2cqw;border-bottom:.25cqw solid #1d3d6b}",
    ".slide .ft{position:absolute;left:5cqw;right:5cqw;bottom:1.8cqw;display:flex;justify-content:space-between;font-size:1.25cqw;color:#5b6678}",
    ".slide.title-s .in{justify-content:center;background:linear-gradient(135deg,#1d3d6b,#2a5592);color:#fff}",
    ".slide.title-s h1{font-family:'IBM Plex Serif',Georgia,serif;font-size:4.6cqw;margin:0;line-height:1.15}",
    ".slide.title-s .s1{font-size:2.4cqw;opacity:.92}.slide.title-s .s2{font-size:1.5cqw;opacity:.75}",
    ".slide .kp{display:grid;grid-template-columns:repeat(3,1fr);gap:1.8cqw;flex:1}",
    ".slide .kp div{border:.12cqw solid #dde2ea;border-left:.6cqw solid var(--c);border-radius:.6cqw;padding:1.6cqw;display:flex;flex-direction:column;justify-content:center;gap:.5cqw}",
    ".slide .kp b{font-size:1.5cqw;color:#5b6678;font-weight:500}.slide .kp strong{font-size:3.2cqw;font-variant-numeric:tabular-nums;line-height:1.1}.slide .kp span{font-size:1.35cqw;color:#5b6678}",
    ".slide ul{margin:0;padding-left:2.4cqw;display:grid;gap:1.1cqw;font-size:1.75cqw;line-height:1.4}",
    ".slide table{border-collapse:collapse;width:100%;font-size:1.45cqw}",
    ".slide th,.slide td{padding:.75cqw 1cqw;border-bottom:.1cqw solid #dde2ea;text-align:left;vertical-align:top}",
    ".slide th{background:#e6ecf5;color:#1d3d6b;font-weight:600}",
    ".slide td.n,.slide th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}",
    ".slide tfoot td{font-weight:700;border-top:.2cqw solid #1d3d6b}",
    ".slide .lg{display:flex;gap:2cqw;font-size:1.4cqw;color:#5b6678}.slide .lg i{display:inline-block;width:1.2cqw;height:1.2cqw;border-radius:.2cqw;margin-right:.6cqw;vertical-align:-.1cqw}",
    ".slide svg{width:100%;flex:1;min-height:0}",
    "@media print{",
    " @page{size:A4 landscape;margin:0}",
    " body.deck-printing>*:not(.deck-ov){display:none!important}",
    " body.deck-printing{background:#fff}",
    " body.deck-printing .deck-ov{position:static;background:#fff;padding:0;display:block}",
    " body.deck-printing .deck-bar,body.deck-printing .deck-msg{display:none}",
    " body.deck-printing .deck-stage{display:block}",
    " body.deck-printing .slide{display:block;width:100%;box-shadow:none;border-radius:0;break-after:page;page-break-after:always;-webkit-print-color-adjust:exact;print-color-adjust:exact}",
    "}"
  ].join("\n");

  function chartSvg(months) {
    var W = 1000, H = 380, L = 44, R = 10, T = 12, B = 34, pw = W - L - R, ph = H - T - B;
    var max = 1; months.forEach(function (m) { max = Math.max(max, m.i, m.o); });
    var step = Math.max(1, Math.ceil(max / 4)), top = step * Math.ceil(max / step);
    var y = function (v) { return T + ph - v / top * ph; };
    var g = "";
    for (var v = 0; v <= top; v += step) g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="#dde2ea"/><text x="' + (L - 8) + '" y="' + (y(v) + 5) + '" text-anchor="end" font-size="14" fill="#5b6678">' + v + '</text>';
    var n = months.length || 1, slot = pw / n, bw = Math.min(34, Math.max(4, (slot - 8) / 2 - 1));
    months.forEach(function (m, k) {
      var cx = L + slot * k + slot / 2;
      if (m.i) g += '<rect x="' + (cx - bw - 1) + '" y="' + y(m.i) + '" width="' + bw + '" height="' + (y(0) - y(m.i)) + '" rx="3" fill="#b8650f"/>';
      if (m.o) g += '<rect x="' + (cx + 1) + '" y="' + y(m.o) + '" width="' + bw + '" height="' + (y(0) - y(m.o)) + '" rx="3" fill="#1f6fb8"/>';
      if (n <= 12 || k % 2 === 0) g += '<text x="' + cx + '" y="' + (H - 10) + '" text-anchor="middle" font-size="14" fill="#5b6678">' + MSHORT[m.m] + (m.m === 0 || k === 0 ? " " + String(m.y).slice(2) : "") + '</text>';
    });
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Поступление дел по месяцам">' + g +
      '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(0) + '" y2="' + y(0) + '" stroke="#5b6678"/></svg>';
  }

  function slideHtml(s, i, total, period) {
    if (s.type === "title") {
      return '<div class="slide title-s"><div class="in"><h1>' + esc(s.title) + '</h1><div class="s1">' + esc(s.sub) + '</div><div class="s2">' + esc(s.note) + '</div></div></div>';
    }
    var body = "";
    if (s.type === "kpi") body = '<div class="kp">' + s.items.map(function (x) { return '<div style="--c:#' + x.c + '"><b>' + esc(x.k) + '</b><strong>' + esc(x.v) + '</strong><span>' + esc(x.s) + '</span></div>'; }).join("") + '</div>';
    if (s.type === "text") body = '<ul>' + s.items.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join("") + '</ul>';
    if (s.type === "chart") body = '<div class="lg"><span><i style="background:#b8650f"></i>входящие</span><span><i style="background:#1f6fb8"></i>исходящие</span></div>' + chartSvg(s.months);
    if (s.type === "table") {
      var td = function (row, tag) { return '<tr>' + row.map(function (x, k) { return '<' + tag + (s.numCols.indexOf(k) >= 0 ? ' class="n"' : '') + '>' + esc(x) + '</' + tag + '>'; }).join("") + '</tr>'; };
      body = '<table><thead>' + td(s.head, "th") + '</thead><tbody>' +
        (s.rows.length ? s.rows.map(function (r) { return td(r, "td"); }).join("") : '<tr><td colspan="' + s.head.length + '">Нет данных за период</td></tr>') +
        '</tbody>' + (s.foot ? '<tfoot>' + td(s.foot, "td") + '</tfoot>' : '') + '</table>';
    }
    return '<div class="slide"><div class="in"><h2>' + esc(s.title) + '</h2>' + body + '</div><div class="ft"><span>Претензионно-исковая работа · ' + esc(period) + '</span><span>' + (i + 1) + ' / ' + total + '</span></div></div>';
  }

  var ov, cur = 0, slides = [], report = null;
  function msg(t) { var m = document.getElementById("deckMsg"); if (m) m.textContent = t || ""; }
  function show(i) {
    var els = ov.querySelectorAll(".slide");
    cur = Math.max(0, Math.min(els.length - 1, i));
    els.forEach(function (el, k) { el.classList.toggle("on", k === cur); });
    document.getElementById("deckPos").textContent = (cur + 1) + " / " + els.length;
  }
  function close() { ov.hidden = true; document.body.style.overflow = ""; }
  function open() {
    if (typeof window.pirReport !== "function") return;
    report = window.pirReport();
    if (!report) return;
    slides = buildSlides(report);
    if (!ov) {
      var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
      ov = document.createElement("div"); ov.className = "deck-ov"; ov.setAttribute("role", "dialog"); ov.setAttribute("aria-modal", "true"); ov.setAttribute("aria-label", "Отчёт в формате презентации");
      document.body.appendChild(ov);
      ov.addEventListener("click", function (e) {
        var b = e.target.closest("[data-deck]"); if (!b) return;
        var a = b.getAttribute("data-deck");
        if (a === "prev") show(cur - 1);
        if (a === "next") show(cur + 1);
        if (a === "close") close();
        if (a === "pptx") downloadPptx(b);
        if (a === "print") { document.body.classList.add("deck-printing"); window.print(); }
      });
      window.addEventListener("afterprint", function () { document.body.classList.remove("deck-printing"); });
      document.addEventListener("keydown", function (e) {
        if (!ov || ov.hidden) return;
        if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") { e.preventDefault(); show(cur + 1); }
        if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); show(cur - 1); }
        if (e.key === "Escape") { e.stopPropagation(); close(); }
      }, true);
    }
    var period = report.p.label.replace(/^за /, "");
    ov.innerHTML =
      '<div class="deck-bar">' +
      '<button class="btn small" type="button" data-deck="prev" aria-label="Предыдущий слайд">←</button>' +
      '<span id="deckPos"></span>' +
      '<button class="btn small" type="button" data-deck="next" aria-label="Следующий слайд">→</button>' +
      '<button class="btn small primary" type="button" data-deck="pptx">Скачать PowerPoint (.pptx)</button>' +
      '<button class="btn small" type="button" data-deck="print">Печать / PDF</button>' +
      '<button class="btn small" type="button" data-deck="close">Закрыть</button></div>' +
      '<div class="deck-msg" id="deckMsg"></div>' +
      '<div class="deck-stage">' + slides.map(function (s, i) { return slideHtml(s, i, slides.length, period); }).join("") + '</div>';
    ov.hidden = false; document.body.style.overflow = "hidden";
    show(0);
  }

  /* ---------- PowerPoint ---------- */
  var libPromise = null;
  function loadLib() {
    if (window.PptxGenJS) return Promise.resolve();
    if (!libPromise) libPromise = new Promise(function (res, rej) {
      var s = document.createElement("script"); s.src = PPTX_URL; s.async = true;
      s.onload = function () { window.PptxGenJS ? res() : rej(new Error("no lib")); };
      s.onerror = function () { libPromise = null; rej(new Error("load failed")); };
      document.head.appendChild(s);
    });
    return libPromise;
  }

  async function downloadPptx(btn) {
    btn.disabled = true; msg("Готовлю файл PowerPoint…");
    try { await loadLib(); }
    catch (e) { btn.disabled = false; msg("Не удалось загрузить модуль PowerPoint: нужен доступ в интернет. Можно сохранить презентацию через «Печать / PDF»."); return; }
    try {
      var pptx = new window.PptxGenJS();
      pptx.layout = "LAYOUT_WIDE"; // 13.33 × 7.5 дюйма
      pptx.title = "Отчёт о претензионно-исковой работе " + report.p.label;
      var FONT = "Segoe UI", W = 13.33, total = slides.length, period = report.p.label.replace(/^за /, "");
      slides.forEach(function (s, i) {
        var sl = pptx.addSlide();
        if (s.type === "title") {
          sl.background = { color: C.accent };
          sl.addText(s.title, { x: 0.8, y: 2.3, w: W - 1.6, h: 1.4, fontFace: "Georgia", fontSize: 40, bold: true, color: "FFFFFF" });
          sl.addText(s.sub, { x: 0.8, y: 3.8, w: W - 1.6, h: 0.6, fontFace: FONT, fontSize: 22, color: "DCE6F5" });
          sl.addText(s.note, { x: 0.8, y: 4.5, w: W - 1.6, h: 0.5, fontFace: FONT, fontSize: 14, color: "B7C7DE" });
          return;
        }
        sl.addText(s.title, { x: 0.6, y: 0.35, w: W - 1.2, h: 0.75, fontFace: "Georgia", fontSize: 28, bold: true, color: C.accent });
        sl.addShape(pptx.ShapeType.line, { x: 0.6, y: 1.12, w: W - 1.2, h: 0, line: { color: C.accent, width: 2 } });
        sl.addText("Претензионно-исковая работа · " + period, { x: 0.6, y: 7.0, w: 9, h: 0.3, fontFace: FONT, fontSize: 10, color: C.muted });
        sl.addText((i + 1) + " / " + total, { x: W - 2.6, y: 7.0, w: 2, h: 0.3, fontFace: FONT, fontSize: 10, color: C.muted, align: "right" });
        if (s.type === "kpi") {
          var cw = (W - 1.2 - 0.5) / 3, ch = 2.5;
          s.items.forEach(function (x, k) {
            var cx = 0.6 + (k % 3) * (cw + 0.25), cy = 1.5 + Math.floor(k / 3) * (ch + 0.3);
            sl.addShape(pptx.ShapeType.rect, { x: cx, y: cy, w: cw, h: ch, fill: { color: "FFFFFF" }, line: { color: C.line, width: 1 } });
            sl.addShape(pptx.ShapeType.rect, { x: cx, y: cy, w: 0.09, h: ch, fill: { color: x.c }, line: { color: x.c, width: 0 } });
            sl.addText([
              { text: x.k, options: { fontSize: 14, color: C.muted, breakLine: true } },
              { text: x.v, options: { fontSize: x.v.length > 12 ? 24 : 34, bold: true, color: C.ink, breakLine: true } },
              { text: x.s, options: { fontSize: 12, color: C.muted } }
            ], { x: cx + 0.3, y: cy + 0.15, w: cw - 0.45, h: ch - 0.3, fontFace: FONT, valign: "middle", paraSpaceAfter: 6 });
          });
        }
        if (s.type === "text") {
          sl.addText(s.items.map(function (t) { return { text: t, options: { bullet: true, breakLine: true } }; }),
            { x: 0.7, y: 1.4, w: W - 1.4, h: 5.4, fontFace: FONT, fontSize: 18, color: C.ink, valign: "top", paraSpaceAfter: 12 });
        }
        if (s.type === "chart") {
          var labels = s.months.map(function (m) { return MSHORT[m.m] + " " + String(m.y).slice(2); });
          sl.addChart(pptx.ChartType.bar, [
            { name: "Входящие", labels: labels, values: s.months.map(function (m) { return m.i; }) },
            { name: "Исходящие", labels: labels, values: s.months.map(function (m) { return m.o; }) }
          ], { x: 0.6, y: 1.35, w: W - 1.2, h: 5.5, barDir: "col", barGrouping: "clustered", chartColors: [C.inc, C.out],
            showLegend: true, legendPos: "b", legendFontSize: 12, catAxisLabelFontSize: 11, valAxisLabelFontSize: 11,
            valAxisMinVal: 0, valGridLine: { color: C.line, size: 0.5 }, catAxisLabelFontFace: FONT, valAxisLabelFontFace: FONT, legendFontFace: FONT });
        }
        if (s.type === "table") {
          var mk = function (row, opt) {
            return row.map(function (x, k) { return { text: String(x), options: Object.assign({ align: s.numCols.indexOf(k) >= 0 ? "right" : "left" }, opt || {}) }; });
          };
          var rows = [mk(s.head, { bold: true, color: C.accent, fill: { color: C.soft } })];
          if (s.rows.length) s.rows.forEach(function (r) { rows.push(mk(r)); });
          else rows.push([{ text: "Нет данных за период", options: { colspan: s.head.length, color: C.muted } }]);
          if (s.foot) rows.push(mk(s.foot, { bold: true }));
          var first = s.head.length > 3 ? 3.6 : (s.head.length === 3 ? 6.9 : 8.9);
          var rest = (W - 1.2 - first) / (s.head.length - 1);
          sl.addTable(rows, { x: 0.6, y: 1.4, w: W - 1.2, colW: [first].concat(s.head.slice(1).map(function () { return rest; })),
            fontFace: FONT, fontSize: 13, color: C.ink, border: { type: "solid", pt: 0.75, color: C.line }, valign: "middle", margin: 0.08 });
        }
      });
      var fname = "Отчёт ПИР " + period.replace(/[\\/:*?"<>|]/g, "") + ".pptx";
      await pptx.writeFile({ fileName: fname });
      msg("Файл «" + fname + "» сохранён в папку загрузок.");
    } catch (e) {
      console.error(e);
      msg("Не удалось сформировать файл PowerPoint. Попробуйте ещё раз или используйте «Печать / PDF».");
    } finally { btn.disabled = false; }
  }

  var b = document.getElementById("aDeck");
  if (b) b.addEventListener("click", open);
})();
