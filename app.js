/* 多多福袋组队码互助池
 * 纯静态前端：号码池存于 textdb.dev 免费文本 KV，截图识别用 Tesseract.js
 */
(function () {
  "use strict";

  /* ================= 配置 ================= */
  /* 号码池存储：textdb.dev 免费文本 KV，GET 读 / POST 覆盖写，CORS 全开
   * （原 restful-api.dev 已于 2026-11 变更策略强制鉴权，弃用） */
  var API = "https://textdb.dev/api/data/ddk-team-pool-7f4e9b2c";
  var SHOW_LIMIT = 20;      // 池中最多展示条数
  var KEEP_LIMIT = 120;     // 远端最多保留条数（防膨胀）
  var POLL_MS = 15000;      // 自动刷新间隔
  var PDD_SCHEME = "pinduoduo://";
  var PDD_FALLBACK = "https://mobile.yangkeduo.com/";

  var TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
  var OCR_OPTS = {
    workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js",
    corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5",
    langPath: "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng"
  };

  /* ================= 状态 ================= */
  var state = {
    codes: [],          // [{id, code, createdAt, usedAt}]
    syncing: false,
    dirty: false,       // 本地有未同步修改
    lastOkAt: 0,
    lastErr: null,
    selection: new Set()
  };
  var myIds = loadMyIds();

  /* ================= 工具 ================= */
  function $(id) { return document.getElementById(id); }

  function toast(msg, warn, ms) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.toggle("warn", !!warn);
    t.classList.remove("hidden");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { t.classList.add("hidden"); }, ms || 2400);
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function validCode(s) { return /^\d{6,12}$/.test(s); }

  function fmtTime(ts) {
    var diff = Date.now() - ts;
    if (diff < 60e3) return "刚刚";
    if (diff < 3600e3) return Math.floor(diff / 60e3) + " 分钟前";
    if (diff < 86400e3) return Math.floor(diff / 3600e3) + " 小时前";
    var d = new Date(ts);
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return (d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function loadMyIds() {
    try { return JSON.parse(localStorage.getItem("ddk_my_ids") || "[]"); }
    catch (e) { return []; }
  }
  function saveMyIds() {
    try { localStorage.setItem("ddk_my_ids", JSON.stringify(myIds.slice(-100))); } catch (e) {}
  }

  function copyText(text, cb) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { cb(true); },
        function () { fallbackCopy(text, cb); });
    } else {
      fallbackCopy(text, cb);
    }
  }
  function fallbackCopy(text, cb) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0;left:-999px";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
    cb(ok);
  }

  /* ================= 存储读写 ================= */
  function fetchPool(cb) {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", API, true);
    xhr.timeout = 12000;
    xhr.onload = function () {
      if (xhr.status === 200) {
        try {
          if (!xhr.responseText) { cb(null, []); return; } // 空池
          var body = JSON.parse(xhr.responseText);
          var codes = (body && Array.isArray(body.codes)) ? body.codes : [];
          cb(null, codes);
        } catch (e) { cb(e); }
      } else { cb(new Error("HTTP " + xhr.status)); }
    };
    xhr.onerror = function () { cb(new Error("网络错误")); };
    xhr.ontimeout = function () { cb(new Error("请求超时")); };
    xhr.send();
  }

  function savePool(codes, cb) {
    var payload = JSON.stringify({ codes: codes, updatedAt: Date.now() });
    var attempt = 0;
    function run() {
      attempt++;
      var xhr = new XMLHttpRequest();
      xhr.open("POST", API, true);
      /* text/plain：避免触发 CORS 预检，textdb 原样存文本 */
      xhr.setRequestHeader("Content-Type", "text/plain");
      xhr.timeout = 12000;
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) cb(null);
        else if (attempt < 3) setTimeout(run, 400 * attempt);
        else cb(new Error("HTTP " + xhr.status));
      };
      xhr.onerror = function () {
        if (attempt < 3) setTimeout(run, 400 * attempt);
        else cb(new Error("网络错误"));
      };
      xhr.ontimeout = function () {
        if (attempt < 3) setTimeout(run, 400 * attempt);
        else cb(new Error("请求超时"));
      };
      xhr.send(payload);
    }
    run();
  }

  /* 远端最多保留 KEEP_LIMIT 条，按时间倒序保留 */
  function prune(codes) {
    return codes.slice().sort(function (a, b) { return b.createdAt - a.createdAt; })
      .slice(0, KEEP_LIMIT);
  }

  /* 对池子的所有修改都经过这里：读 → 改 → 存 → 刷新视图 */
  function mutate(fn, doneMsg) {
    /* 同步进行中不拒绝操作，自动排队稍后执行 */
    if (state.syncing) {
      setTimeout(function () { mutate(fn, doneMsg); }, 500);
      return;
    }
    state.syncing = true;
    setStatus("syncing");
    fetchPool(function (err, remote) {
      if (err) {
        state.syncing = false;
        setStatus("err");
        toast("读取号码池失败：" + err.message, true);
        return;
      }
      var next = fn(remote.slice());
      if (next === null) { // fn 判定无需变更
        state.syncing = false;
        state.codes = remote;
        renderPool();
        setStatus("ok");
        return;
      }
      next = prune(next);
      savePool(next, function (err2) {
        state.syncing = false;
        if (err2) {
          setStatus("err");
          toast("保存失败：" + err2.message + "，稍后自动重试", true);
          state.dirty = true;
        } else {
          state.codes = next;
          state.lastOkAt = Date.now();
          setStatus("ok");
          renderPool();
          if (doneMsg) toast(doneMsg);
        }
      });
    });
  }

  function flushDirty() {
    if (!state.dirty) return;
    savePool(state.codes, function (err) {
      if (!err) { state.dirty = false; }
    });
  }

  function setStatus(s) {
    var dot = $("poolStatus");
    dot.className = "status-dot " + s;
  }

  /* ================= 号码池渲染 ================= */
  function renderPool() {
    var list = $("poolList");
    list.innerHTML = "";
    var sorted = state.codes.slice().sort(function (a, b) { return b.createdAt - a.createdAt; });
    var shown = sorted.slice(0, SHOW_LIMIT);
    var unusedCount = sorted.filter(function (c) { return !c.usedAt; }).length;

    $("poolStat").textContent = "未使用 " + unusedCount + " · 共 " + sorted.length + " 条";
    $("emptyState").classList.toggle("hidden", shown.length > 0);

    shown.forEach(function (item) {
      var used = !!item.usedAt;
      var li = document.createElement("li");
      li.className = "pool-item" + (used ? " used" : "") +
        (state.selection.has(item.id) ? " selected" : "");
      li.dataset.id = item.id;

      var code = document.createElement("div");
      code.className = "code-text";
      code.textContent = item.code;

      var meta = document.createElement("div");
      meta.className = "code-meta";
      var time = document.createElement("span");
      time.className = "code-time";
      time.textContent = used ? "已用 " + fmtTime(item.usedAt) : fmtTime(item.createdAt);
      meta.appendChild(time);
      var tag = document.createElement("span");
      if (used) {
        tag.className = "code-tag used-tag";
        tag.textContent = "已使用";
      } else if (myIds.indexOf(item.id) !== -1) {
        tag.className = "code-tag";
        tag.textContent = "我发的";
      } else {
        tag.className = "code-tag used-tag";
        tag.textContent = "待组队";
      }
      meta.appendChild(tag);

      var actions = document.createElement("div");
      actions.className = "item-actions";
      if (!used) {
        actions.appendChild(makeBtn("复制", "btn primary small", function (e) {
          e.stopPropagation();
          copyAndUse(item.id, li);
        }));
        actions.appendChild(makeBtn("标记已用", "btn ghost small", function (e) {
          e.stopPropagation();
          markUsed([item.id]);
        }));
      } else if (myIds.indexOf(item.id) !== -1) {
        actions.appendChild(makeBtn("再发一次", "btn ghost small", function (e) {
          e.stopPropagation();
          republish(item.code);
        }));
      }

      li.appendChild(code);
      li.appendChild(meta);
      li.appendChild(actions);

      li.addEventListener("click", function () {
        if (used) return;
        toggleSelect(item.id);
      });

      list.appendChild(li);
    });

    updateSelectionBar();
  }

  /* ================= 一键领取 ================= */
  /* 自动领取最早发布的一条「非自己发的未使用码」：复制 → 标记已用 → 跳拼多多 */
  function claimOne() {
    var candidates = state.codes.filter(function (c) {
      return !c.usedAt && myIds.indexOf(c.id) === -1;
    });
    if (!candidates.length) {
      toast(state.codes.some(function (c) { return !c.usedAt; })
        ? "剩下的都是你自己发的码，去让别人领吧～"
        : "号码池暂无可领取的码，等别人发布后再来", true, 3200);
      return;
    }
    candidates.sort(function (a, b) { return a.createdAt - b.createdAt; });
    var target = candidates[0];
    var rowEl = document.querySelector('.pool-item[data-id="' + target.id + '"]');
    copyAndUse(target.id, rowEl);
  }

  function makeBtn(text, cls, onClick) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  }

  /* ================= 复制 / 占用 ================= */
  function copyAndUse(id, rowEl) {
    var item = null;
    state.codes.forEach(function (c) { if (c.id === id) item = c; });
    if (!item || item.usedAt) return;
    /* 跳转必须在点击的同步阶段发起（iOS Safari 对异步回调里的跳转有拦截），复制并行执行 */
    openPddFlow();
    copyText(item.code, function (ok) {
      if (ok && rowEl) rowEl.classList.add("flash");
      markUsed([id], ok ? "已复制 " + item.code + "，去拼多多粘贴吧" : null, ok);
      if (!ok) toast("复制失败，请回到页面长按号码手动复制", true, 4000);
    });
  }

  function markUsed(ids, msg, copied) {
    var idSet = {};
    ids.forEach(function (i) { idSet[i] = true; });
    mutate(function (codes) {
      var changed = false;
      codes.forEach(function (c) {
        if (idSet[c.id] && !c.usedAt) { c.usedAt = Date.now(); changed = true; }
      });
      return changed ? codes : null;
    }, msg || (copied ? "已复制" : "已标记为已使用"));
  }

  /* 跳转拼多多：必须由用户点击直接触发导航，iframe 方式会被移动端浏览器拦截 */
  function openPddFlow() {
    var ua = navigator.userAgent;
    var inWeChat = /micromessenger/i.test(ua);
    var isAndroid = /android/i.test(ua);
    var isIOS = /iphone|ipad|ipod/i.test(ua);

    if (inWeChat) {
      toast("微信内无法直接跳转其他 App：点右上角「···」→「在浏览器打开」后再复制跳转", true, 5000);
      return;
    }

    var start = Date.now();
    var url;
    if (isAndroid) {
      /* intent:// 带 fallback：未安装 App 时浏览器自动打开网页版 */
      url = "intent://#Intent;scheme=pinduoduo;package=com.xunmeng.pinduoduo;S.browser_fallback_url=" +
        encodeURIComponent(PDD_FALLBACK) + ";end";
    } else {
      /* iOS 及桌面：直接拉 scheme */
      url = PDD_SCHEME;
    }
    try { window.location.href = url; } catch (e) {}

    setTimeout(function () {
      if (!document.hidden && Date.now() - start < 2500) {
        toast(isIOS ? "没跳转？可能未安装拼多多 App，去 App Store 安装后重试，或打开 mobile.yangkeduo.com 粘贴口令"
                    : "没跳转？可打开 mobile.yangkeduo.com 粘贴口令", false, 4500);
      }
    }, 2200);
  }

  /* ================= 选择与批量操作 ================= */
  function toggleSelect(id) {
    if (state.selection.has(id)) state.selection.delete(id);
    else state.selection.add(id);
    renderPool();
  }

  function updateSelectionBar() {
    var bar = $("selectionBar");
    var n = state.selection.size;
    bar.classList.toggle("hidden", n === 0);
    $("selectionCount").textContent = "已选 " + n + " 个";
    $("selCopyBtn").disabled = n !== 1;
  }

  function selCopy() {
    var ids = Array.from(state.selection);
    if (ids.length !== 1) return;
    var id = ids[0];
    var rowEl = document.querySelector('.pool-item[data-id="' + id + '"]');
    state.selection.clear();
    copyAndUse(id, rowEl);
  }

  function selUsed() {
    var ids = Array.from(state.selection);
    state.selection.clear();
    if (!ids.length) return;
    markUsed(ids);
  }

  /* ================= 发布（乐观更新：先上屏，后台静默同步） ================= */
  var pending = [];   // 待同步到远端的条目

  function publish(code, doneMsg) {
    code = code.trim();
    if (!validCode(code)) {
      toast("组队码应为 6–12 位纯数字，请检查", true);
      return;
    }
    var item = { id: uid(), code: code, createdAt: Date.now(), usedAt: null };
    pending.push(item);
    /* 本地立即置顶显示，不等网络 */
    state.codes.push(item);
    state.codes = prune(state.codes);
    renderPool();
    myIds.push(item.id);
    saveMyIds();
    toast(doneMsg || ("已发布 " + code + "，已置顶"));
    var dup = state.codes.some(function (c) {
      return c.id !== item.id && !c.usedAt && c.code === code;
    });
    if (dup) {
      setTimeout(function () {
        toast("提示：池中已有相同的未使用码，重复发布不影响使用", true, 3600);
      }, 1200);
    }
    flushPending();
  }

  /* 把 pending 条目合并进远端池子（后台执行，不阻塞界面） */
  function flushPending() {
    if (state.syncing || !pending.length) return;
    state.syncing = true;
    setStatus("syncing");
    fetchPool(function (err, remote) {
      if (err) {
        state.syncing = false;
        setStatus("err");
        setTimeout(flushPending, 4000);   // 稍后自动重试
        return;
      }
      var have = {};
      remote.forEach(function (c) { have[c.id] = true; });
      var toAdd = pending.filter(function (p) { return !have[p.id]; });
      pending = [];
      var next = prune(remote.concat(toAdd));
      savePool(next, function (err2) {
        state.syncing = false;
        if (err2) {
          setStatus("err");
          pending = toAdd;
          setTimeout(flushPending, 4000); // 保存失败自动重试
          return;
        }
        state.codes = next;
        state.lastOkAt = Date.now();
        setStatus("ok");
        renderPool();
      });
    });
  }

  function republish(code) {
    publish(code, "已重新发布 " + code);
  }

  /* ================= OCR 截图识别 ================= */
  var ocrWorker = null;
  var ocrLoading = false;

  function loadTesseract(cb) {
    if (window.Tesseract) return cb(null);
    var s = document.createElement("script");
    s.src = TESSERACT_URL;
    s.onload = function () { cb(null); };
    s.onerror = function () { cb(new Error("识别引擎加载失败，请检查网络后重试")); };
    document.head.appendChild(s);
  }

  function ensureWorker(cb) {
    if (ocrWorker) return cb(null, ocrWorker);
    if (ocrLoading) { setTimeout(function () { ensureWorker(cb); }, 300); return; }
    ocrLoading = true;
    loadTesseract(function (err) {
      if (err) { ocrLoading = false; return cb(err); }
      Tesseract.createWorker("eng", 1, OCR_OPTS).then(function (w) {
        ocrWorker = w;
        ocrLoading = false;
        cb(null, w);
      }).catch(function (e) {
        ocrLoading = false;
        cb(e);
      });
    });
  }

  function imageToCanvas(img) {
    var maxW = 1200;
    var scale = Math.min(1, maxW / img.naturalWidth);
    var w = Math.round(img.naturalWidth * scale);
    var h = Math.round(img.naturalHeight * scale);
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    return canvas;
  }

  function extractCodes(text) {
    var out = [];
    var seen = {};
    var re = /(?<!\d)(\d{6,12})(?!\d)/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (!seen[m[1]]) { seen[m[1]] = true; out.push(m[1]); }
    }
    /* 长度优先（组队码通常 8–9 位），其次按出现顺序 */
    out.sort(function (a, b) { return b.length - a.length; });
    return out;
  }

  function ocrImage(img) {
    var status = $("ocrStatus");
    status.classList.remove("hidden", "err");
    status.innerHTML = "";
    var sp = document.createElement("span");
    sp.className = "spinner";
    status.appendChild(sp);
    status.appendChild(document.createTextNode("正在识别数字…首次使用需下载识别引擎（约 5 MB），请稍候"));

    ensureWorker(function (err, worker) {
      if (err) {
        status.classList.add("err");
        status.textContent = "识别引擎加载失败：" + err.message + "。可直接改用手动输入发布。";
        return;
      }
      var canvas = imageToCanvas(img);
      var psm = "11"; // SPARSE_TEXT：适合带大量界面文字的截图
      function run() {
        worker.setParameters({
          tessedit_char_whitelist: "0123456789",
          tessedit_pageseg_mode: psm
        }).then(function () {
          return worker.recognize(canvas);
        }).then(function (res) {
          var found = extractCodes(res.data.text || "");
          if (!found.length && psm === "11") { psm = "6"; run(); return; }
          showCandidates(found);
          status.classList.add("hidden");
        }).catch(function (e) {
          status.classList.add("err");
          status.textContent = "识别失败：" + e.message + "。可重试或手动输入。";
        });
      }
      run();
    });
  }

  function showCandidates(list) {
    var box = $("candidateBox");
    var chips = $("candidateChips");
    chips.innerHTML = "";
    if (!list.length) {
      box.classList.remove("hidden");
      $("candidateChips").innerHTML = "";
      var p = document.createElement("p");
      p.className = "candidate-title";
      p.style.color = "var(--accent-dark)";
      p.textContent = "没识别出 6 位以上的连续数字。请换一张更清晰的截图（截小一点、只含组队码），或直接在下方手动输入。";
      chips.appendChild(p);
      return;
    }
    list.slice(0, 6).forEach(function (codeText, i) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip" + (i === 0 ? " selected" : "");
      chip.textContent = codeText;
      chip.addEventListener("click", function () {
        Array.prototype.forEach.call(chips.querySelectorAll(".chip"), function (c) {
          c.classList.remove("selected");
        });
        chip.classList.add("selected");
        $("ocrInput").value = codeText;
      });
      chips.appendChild(chip);
    });
    box.classList.remove("hidden");
    $("ocrInput").value = list[0];
  }

  /* ================= 事件绑定 ================= */
  function bindEvents() {
    /* tab 切换 */
    $("tabManual").addEventListener("click", function () { switchTab(true); });
    $("tabOcr").addEventListener("click", function () { switchTab(false); });

    /* 手动发布 */
    $("manualInput").addEventListener("input", function () {
      this.value = this.value.replace(/\D/g, "").slice(0, 12);
    });
    $("manualInput").addEventListener("keydown", function (e) {
      if (e.key === "Enter") publish(this.value);
    });
    $("manualPublishBtn").addEventListener("click", function () {
      publish($("manualInput").value);
      $("manualInput").value = "";
    });

    /* OCR 发布 */
    $("ocrInput").addEventListener("input", function () {
      this.value = this.value.replace(/\D/g, "").slice(0, 12);
    });
    $("ocrPublishBtn").addEventListener("click", function () {
      publish($("ocrInput").value);
      $("ocrInput").value = "";
    });

    /* dropzone：点击 / 拖拽 / 粘贴 */
    var dz = $("dropZone");
    dz.addEventListener("click", function () { $("fileInput").click(); });
    dz.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") $("fileInput").click();
    });
    $("fileInput").addEventListener("change", function () {
      if (this.files && this.files[0]) loadImageFile(this.files[0]);
    });
    ["dragover", "dragenter"].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add("dragover"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove("dragover"); });
    });
    dz.addEventListener("drop", function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadImageFile(f);
    });
    document.addEventListener("paste", function (e) {
      if ($("paneOcr").classList.contains("hidden")) return;
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf("image") === 0) {
          loadImageFile(items[i].getAsFile());
          e.preventDefault();
          break;
        }
      }
    });

    /* 刷新 / 一键领取 */
    $("refreshBtn").addEventListener("click", function () { refresh(); });
    $("claimBtn").addEventListener("click", claimOne);

    /* 批量操作 */
    $("selCopyBtn").addEventListener("click", selCopy);
    $("selUsedBtn").addEventListener("click", selUsed);
    $("selClearBtn").addEventListener("click", function () {
      state.selection.clear();
      renderPool();
    });
  }

  function switchTab(manual) {
    $("tabManual").classList.toggle("active", manual);
    $("tabOcr").classList.toggle("active", !manual);
    $("paneManual").classList.toggle("hidden", !manual);
    $("paneOcr").classList.toggle("hidden", manual);
  }

  function loadImageFile(file) {
    if (!file.type || file.type.indexOf("image") !== 0) {
      toast("请选择图片文件", true);
      return;
    }
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      $("previewImg").src = url;
      $("dzIdle").classList.add("hidden");
      $("dzPreview").classList.remove("hidden");
      ocrImage(img);
    };
    img.onerror = function () {
      toast("图片加载失败，请换一张试试", true);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }

  /* ================= 刷新循环 ================= */
  function refresh() {
    if (state.syncing) return;
    setStatus("syncing");
    fetchPool(function (err, codes) {
      if (err) {
        setStatus("err");
        $("poolStat").textContent = "同步失败，将自动重试";
        return;
      }
      state.codes = codes;
      /* 刷新时保住尚未同步成功的本地发布，避免闪没 */
      if (pending.length) {
        var have = {};
        codes.forEach(function (c) { have[c.id] = true; });
        pending.forEach(function (p) { if (!have[p.id]) state.codes.push(p); });
      }
      state.lastOkAt = Date.now();
      setStatus("ok");
      renderPool();
    });
  }

  function startPolling() {
    setInterval(function () {
      if (document.hidden) return;
      refresh();
    }, POLL_MS);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) { refresh(); flushDirty(); }
    });
  }

  /* ================= 启动 ================= */
  bindEvents();
  refresh();
  startPolling();

  /* PWA：注册 Service Worker（仅 https 或 localhost 下生效） */
  if ("serviceWorker" in navigator &&
      (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }
})();
