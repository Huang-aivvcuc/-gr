/* =========================================================
   大板场 SLABYARD · Demo 交互脚本（原生 JS，无依赖）
   ========================================================= */
(function () {
  "use strict";

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- 1. 导航吸顶 ---------- */
  var nav = document.querySelector(".nav");
  function onScrollNav() {
    if (!nav) return;
    nav.classList.toggle("is-stuck", window.scrollY > 40);
  }
  onScrollNav();
  window.addEventListener("scroll", onScrollNav, { passive: true });

  /* ---------- 2. 移动端抽屉 ---------- */
  var burger = document.querySelector(".burger");
  var drawer = document.querySelector(".drawer");
  if (burger && drawer) {
    burger.addEventListener("click", function () {
      drawer.classList.add("open");
      document.body.style.overflow = "hidden";
    });
    drawer.addEventListener("click", function (e) {
      if (e.target.closest(".close") || e.target.tagName === "A") {
        drawer.classList.remove("open");
        document.body.style.overflow = "";
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && drawer.classList.contains("open")) {
        drawer.classList.remove("open");
        document.body.style.overflow = "";
      }
    });
  }

  /* ---------- 3. 首屏大板轮播 ---------- */
  var slides = Array.prototype.slice.call(document.querySelectorAll(".hero-bg .slide"));
  var dots = Array.prototype.slice.call(document.querySelectorAll(".hero-index button"));
  if (slides.length > 1) {
    var idx = 0, timer = null;
    var paint = function (n) {
      idx = (n + slides.length) % slides.length;
      slides.forEach(function (s, i) { s.classList.toggle("on", i === idx); });
      dots.forEach(function (d, i) {
        d.classList.toggle("on", i === idx);
        d.setAttribute("aria-current", i === idx ? "true" : "false");
      });
    };
    var start = function () {
      if (reduce) return;
      timer = window.setInterval(function () { paint(idx + 1); }, 6200);
    };
    dots.forEach(function (d, i) {
      d.addEventListener("click", function () {
        window.clearInterval(timer);
        paint(i);
        start();
      });
    });
    paint(0);
    start();
  }

  /* ---------- 4. 滚动入场 ---------- */
  var revealables = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && !reduce) {
    var ro = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add("in");
          ro.unobserve(en.target);
        }
      });
    }, { threshold: 0.14, rootMargin: "0px 0px -8% 0px" });
    revealables.forEach(function (el) { ro.observe(el); });
  } else {
    revealables.forEach(function (el) { el.classList.add("in"); });
  }

  /* ---------- 5. 数字跳动 ---------- */
  var nums = document.querySelectorAll(".stat [data-to]");
  function runCount(el) {
    var to = parseFloat(el.getAttribute("data-to"));
    var suffix = el.getAttribute("data-suffix") || "";
    var dur = 1500, t0 = null;
    if (reduce) { el.firstChild.nodeValue = String(to); return; }
    function frame(ts) {
      if (!t0) t0 = ts;
      var p = Math.min((ts - t0) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.firstChild.nodeValue = String(Math.round(to * eased));
      if (p < 1) requestAnimationFrame(frame);
      else el.firstChild.nodeValue = String(to) + suffix;
    }
    requestAnimationFrame(frame);
  }
  if ("IntersectionObserver" in window) {
    var co = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { runCount(en.target); co.unobserve(en.target); }
      });
    }, { threshold: 0.6 });
    nums.forEach(function (el) { co.observe(el); });
  }

  /* ---------- 6. 手风琴（FAQ） ---------- */
  var buttons = document.querySelectorAll(".acc-btn");
  function closePanel(btn) {
    var p = document.getElementById(btn.getAttribute("aria-controls"));
    if (!p) return;
    btn.setAttribute("aria-expanded", "false");
    p.style.height = p.scrollHeight + "px";
    requestAnimationFrame(function () { p.style.height = "0px"; });
  }
  function openPanel(btn) {
    var p = document.getElementById(btn.getAttribute("aria-controls"));
    if (!p) return;
    btn.setAttribute("aria-expanded", "true");
    p.style.height = p.scrollHeight + "px";
    var done = function (e) {
      if (e.propertyName === "height" && btn.getAttribute("aria-expanded") === "true") {
        p.style.height = "auto";
      }
      p.removeEventListener("transitionend", done);
    };
    p.addEventListener("transitionend", done);
  }
  Array.prototype.forEach.call(buttons, function (btn) {
    var open = btn.getAttribute("aria-expanded") === "true";
    var panel = document.getElementById(btn.getAttribute("aria-controls"));
    if (panel) panel.style.height = open ? "auto" : "0px";
    btn.addEventListener("click", function () {
      var expanded = btn.getAttribute("aria-expanded") === "true";
      var group = btn.getAttribute("data-group") || "default";
      document.querySelectorAll('.acc-btn[data-group="' + group + '"]').forEach(function (other) {
        if (other !== btn && other.getAttribute("aria-expanded") === "true") closePanel(other);
      });
      if (expanded) closePanel(btn); else openPanel(btn);
    });
  });
  window.addEventListener("resize", function () {
    document.querySelectorAll('.acc-btn[aria-expanded="true"]').forEach(function (b) {
      var p = document.getElementById(b.getAttribute("aria-controls"));
      if (p) p.style.height = "auto";
    });
  });

  /* ---------- 7. 回到顶部 ---------- */
  var top = document.querySelector(".toTop");
  if (top) {
    window.addEventListener("scroll", function () {
      top.classList.toggle("on", window.scrollY > 900);
    }, { passive: true });
    top.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    });
  }

  /* ---------- 8. 询盘表单：提交到 Worker API，后端不可达时自动回落 mailto ---------- */
  var form = document.getElementById("inquiry-form");
  if (form) {
    var note = document.getElementById("inquiry-note");
    var btn = document.getElementById("inquiry-submit");
    var API = form.getAttribute("data-api") || "/api/inquiry";
    var MAIL = form.getAttribute("data-mailto") || "gaoruistone@icloud.com";
    var FIELDS = ["name", "company", "country", "email", "whatsapp", "project", "area", "finish", "message", "website"];
    var LABELS = [["Name", "name"], ["Company", "company"], ["Country", "country"], ["Email", "email"],
                  ["WhatsApp", "whatsapp"], ["Project", "project"], ["Area", "area"], ["Finish", "finish"], ["Message", "message"]];

    function payload() {
      var fd = new FormData(form), o = {};
      FIELDS.forEach(function (k) { o[k] = (fd.get(k) || "").toString().trim(); });
      o.page = (location.pathname.split("/").pop() || "index.html").slice(0, 120);
      return o;
    }

    function say(msg, color) {
      if (!note) return;
      note.textContent = msg;
      note.style.color = color || "var(--copper)";
      note.style.display = "block";
    }

    function mailto(d) {
      var lines = [];
      LABELS.forEach(function (p) { if (d[p[1]]) lines.push(p[0] + ": " + d[p[1]]); });
      window.location.href = "mailto:" + MAIL + "?subject=" +
        encodeURIComponent("Inquiry from " + (d.company || d.name || "website")) +
        "&body=" + encodeURIComponent(lines.join("\n"));
    }

    function unlock() {
      if (!btn) return;
      btn.disabled = false;
      btn.innerHTML = 'Send Inquiry <span class="arw">\u2192</span>';
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var d = payload();
      if (btn) { btn.disabled = true; btn.textContent = "Sending\u2026"; }

      // 本地双击打开（file://）无后端，直接走邮件，不报错
      if (location.protocol === "file:") {
        say("Opening your email app with the details pre-filled. You can also WhatsApp +86 138 2689 6277.");
        mailto(d); unlock(); return;
      }

      fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(d)
      }).then(function (r) {
        return r.json().catch(function () { throw new Error("bad response"); });
      }).then(function (res) {
        if (!res || !res.ok) throw new Error((res && res.error) || "failed");
        form.reset();
        say("\u2713 Inquiry received. We reply within one business day (CST 8:00\u201318:00), usually sooner. Urgent? WhatsApp +86 138 2689 6277.", "#2f7d51");
      }).catch(function () {
        say("Couldn\u2019t reach our server, so we opened your email app instead \u2014 nothing you typed is lost.", "var(--copper)");
        mailto(d);
      }).then(unlock);
    });
  }
})();
