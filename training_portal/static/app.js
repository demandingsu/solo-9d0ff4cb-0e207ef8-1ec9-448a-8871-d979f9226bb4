// Poll the lightweight status endpoint and patch the job / export rows in place.
//
// Rows are updated, never reloaded: while a generation is held at the demo
// pause gate the operator is typing a respondent id into the revoke form, and a
// page reload would wipe that field at the worst possible moment.
(function () {
  const ACTIVE = new Set(["queued", "running", "paused"]);
  const LABELS = {
    queued: "排队中",
    running: "生成中",
    paused: "演示暂停",
    completed: "已完成",
    blocked: "已阻止",
    failed: "失败",
    ready: "可下载",
    pending_delete: "待清理",
    deleted: "已删除",
  };
  const INTEGRITY_LABELS = {
    verified: "已核验",
    unverified: "未核验",
    failed: "校验失败",
  };
  let timer = null;
  let idlePolls = 0;
  const MAX_IDLE_POLLS = 60;

  function pill(el, status) {
    if (!el || el.dataset.status === status) return;
    el.dataset.status = status;
    el.textContent = LABELS[status] || status;
    el.className = "pill pill-" + status;
  }

  function integrityPill(el, state) {
    if (!el || el.dataset.integrity === state) return;
    el.dataset.integrity = state;
    el.textContent = INTEGRITY_LABELS[state] || state;
    el.className = "pill pill-integ-" + state;
  }

  function flashError(message) {
    let box = document.getElementById("download-error");
    if (!box) {
      box = document.createElement("div");
      box.id = "download-error";
      box.className = "flash flash-error";
      box.setAttribute("role", "alert");
      const main = document.querySelector("main.wrap");
      if (main) main.insertBefore(box, main.firstChild);
    }
    box.textContent = "下载失败：" + message;
  }

  // Download through fetch so a refused export (revoked consent or failed
  // content verification) becomes a visible message instead of a raw JSON
  // page. The server only sends bytes after the digest check passes.
  async function downloadExport(event, exportId) {
    event.preventDefault();
    const link = event.currentTarget;
    link.setAttribute("aria-disabled", "true");
    try {
      const res = await fetch(`/download/${exportId}`, { cache: "no-store" });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (body && body.error) message = body.error;
        } catch (err) {
          /* non-JSON error body */
        }
        flashError(message);
        return false;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") || "";
      const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
      const plain = /filename="([^"]+)"/i.exec(disposition);
      const name = utf8
        ? decodeURIComponent(utf8[1])
        : plain
        ? plain[1]
        : `export-${exportId}.csv`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const box = document.getElementById("download-error");
      if (box) box.remove();
      return false;
    } catch (err) {
      flashError("网络中断或服务器无响应");
      return false;
    } finally {
      link.removeAttribute("aria-disabled");
    }
  }

  window.downloadExport = downloadExport;

  function patch(data) {
    let idle = true;

    for (const job of data.jobs || []) {
      const row = document.querySelector(`tr[data-job="${job.id}"]`);
      if (!row) continue;
      pill(row.querySelector("[data-job-status]"), job.status);
      const progress = row.querySelector("[data-job-progress]");
      if (progress) progress.textContent = `${job.written_rows} / ${job.total_rows}`;
      const message = row.querySelector("[data-job-message]");
      if (message) message.textContent = job.message || "";
      if (ACTIVE.has(job.status)) idle = false;
    }

    for (const item of data.exports || []) {
      const row = document.querySelector(`tr[data-export="${item.id}"]`);
      if (!row) continue;
      pill(row.querySelector("[data-export-status]"), item.status);
      integrityPill(row.querySelector("[data-export-integrity]"), item.integrity);
      const reason = row.querySelector("[data-export-reason]");
      if (reason) reason.textContent = item.purge_reason || item.last_delete_error || "";
      const attempts = row.querySelector("[data-export-attempts]");
      if (attempts) attempts.textContent = item.delete_attempts;
      const action = row.querySelector("[data-export-action]");
      if (action) {
        if (item.status === "ready") {
          if (!action.querySelector("a")) {
            const link = document.createElement("a");
            link.className = "btn btn-small";
            link.href = `/download/${item.id}`;
            link.textContent = "下载";
            link.addEventListener("click", (event) => downloadExport(event, item.id));
            action.replaceChildren(link);
          }
        } else if (action.querySelector("a")) {
          action.innerHTML = '<span class="hint small">不可下载</span>';
        }
      }
      if (item.status === "pending_delete") idle = false;
    }
    return idle;
  }

  async function check() {
    let idle = true;
    try {
      const res = await fetch("/api/status", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (res.ok) {
        idle = patch(await res.json());
      }
    } catch (err) {
      /* transient network error: retry */
    }
    // Stop after a minute with nothing active, so an idle page is quiet.
    idlePolls = idle ? idlePolls + 1 : 0;
    if (idlePolls < MAX_IDLE_POLLS) schedule(idle ? 4000 : 1200);
  }

  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(check, delay);
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (
      document.querySelector(".pill-running, .pill-queued, .pill-paused")
    ) {
      schedule(700);
    }
  });
})();
