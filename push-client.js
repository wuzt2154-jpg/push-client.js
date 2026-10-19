/* SAME PLACE | Push Notification Client */

(() => {
  "use strict";

  const root = new URL("./", document.currentScript?.src || location.href);
  const workerURL = new URL("service-worker.js", root);

  const quietKey = "sp_push_quiet_v1";
  const seen = new Map();

  let channel = null;
  let channelUser = null;
  let authUserId = null;
  let pendingLink = false;

  const $ = id => document.getElementById(id);

  const user = () =>
    typeof me !== "undefined" ? me : null;

  const quiet = () =>
    localStorage.getItem(quietKey) === "1";

  const status = msg => {
    if ($("spPushStatus")) {
      $("spPushStatus").textContent = msg;
    }
  };

  const supports = () =>
    isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;

  const senderName = id =>
    typeof members !== "undefined"
      ? members.find(x => x.user_id === id)?.profiles?.nickname ||
        "一位同场成员"
      : "一位同场成员";

  const summary = r => {
    if (r.media_type === "video") return "给你发来一段视频";
    if (r.media_type === "image") return "给你发来一张图片";
    if (r.media_type === "audio") return "给你发来一条语音消息";
    return "给你发来一条新消息";
  };

  function bytes(s) {
    let t = s.replace(/-/g, "+").replace(/_/g, "/");
    t += "=".repeat((4 - t.length % 4) % 4);

    return Uint8Array.from(
      atob(t),
      x => x.charCodeAt(0)
    );
  }

  async function registration() {
    return navigator.serviceWorker.getRegistration(root.pathname);
  }

  async function announceIdentity(id) {
    try {
      const r = await registration();
      const sw = r?.active || navigator.serviceWorker.controller;

      sw?.postMessage({
        kind: "SP_IDENTITY",
        user_id: id || null
      });
    } catch (e) {
      console.warn("SW identity:", e);
    }
  }

  function activeChat(r) {
    return (
      (typeof SP !== "undefined" ? SP?.id : null) === r.space_id &&
      $("page-chat")?.classList.contains("active") &&
      (typeof state !== "undefined" ? state?.activeChat : null) ===
        r.sender_id
    );
  }

  async function jump(r) {
    if (!user()) {
      location.assign(
        new URL(
          "?space_id=" +
            encodeURIComponent(r.space_id) +
            "&dm=" +
            encodeURIComponent(r.sender_id),
          root
        )
      );
      return;
    }

    if ((typeof SP !== "undefined" ? SP?.id : null) !== r.space_id) {
      const { data: membership, error: memError } = await sb
        .from("space_members")
        .select("space_id")
        .eq("space_id", r.space_id)
        .eq("user_id", user().id)
        .eq("status", "active")
        .eq("banned", false)
        .maybeSingle();

      if (memError || !membership) {
        if (typeof toast === "function") {
          toast("你没有进入该空间的权限");
        }
        return;
      }

      const { data: space, error } = await sb
        .from("spaces")
        .select("slug")
        .eq("id", r.space_id)
        .maybeSingle();

      if (error || !space?.slug) {
        if (typeof toast === "function") {
          toast("无法定位消息所属空间");
        }
        return;
      }

      await enterSpace(space.slug);
    }

    if (
      (typeof SP !== "undefined" ? SP?.id : null) === r.space_id &&
      typeof openInboxChat === "function"
    ) {
      openInboxChat(r.sender_id);
    }
  }

  function alertFor(r) {
    if (!user() || quiet() || r.sender_id === user().id) {
      return false;
    }

    if (
      typeof blocked !== "undefined" &&
      blocked.has(r.sender_id)
    ) {
      return false;
    }

    if (
      activeChat(r) &&
      document.visibilityState === "visible"
    ) {
      return true;
    }

    const container = $("spDmAlerts");
    if (!container) return false;

    const card = document.createElement("div");
    card.className = "sp-dm-alert";
    card.setAttribute("role", "status");

    const main = document.createElement("div");

    const title = document.createElement("strong");
    title.textContent =
      senderName(r.sender_id) + " · 新私聊";

    const line = document.createElement("p");
    line.textContent = summary(r);

    const open = document.createElement("button");
    open.textContent = "查看消息 ↗";

    open.addEventListener("click", () => {
      card.remove();
      jump(r).catch(console.warn);
    });

    const close = document.createElement("button");
    close.setAttribute("aria-label", "关闭");
    close.textContent = "×";

    close.addEventListener("click", () => card.remove());

    main.append(title, line, open);
    card.append(main, close);
    container.prepend(card);

    setTimeout(() => card.remove(), 8500);

    return true;
  }

  async function incoming(r) {
    if (
      !r?.id ||
      !user() ||
      r.receiver_id !== user().id
    ) {
      return false;
    }

    if (seen.has(r.id)) return true;

    seen.set(r.id, Date.now());

    if (seen.size > 300) {
      for (const [id, t] of seen) {
        if (Date.now() - t > 3600000) {
          seen.delete(id);
        }
      }
    }

    const shown = alertFor(r);

    if (
      (typeof SP !== "undefined" ? SP?.id : null) ===
      r.space_id
    ) {
      if (typeof loadInbox === "function") {
        await loadInbox();
      }

      if (typeof renderInbox === "function") {
        renderInbox();
      }

      if (typeof updateMessageBadges === "function") {
        updateMessageBadges();
      }
    }

    return shown;
  }

  function connect(id) {
    if (channel && channelUser === id) return;

    if (channel) {
      sb.removeChannel(channel);
      channel = null;
    }

    channelUser = id || null;

    if (!id) return;

    channel = sb
      .channel("sp-alert-" + id)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: "receiver_id=eq." + id
        },
        payload => {
          incoming(payload.new).catch(console.warn);
        }
      )
      .subscribe();
  }

  async function unsubscribeAndRemove(owner) {
    if (!supports()) return;

    const r = await registration();
    const sub = await r?.pushManager.getSubscription();

    if (!sub) {
      await announceIdentity(null);
      return;
    }

    if (owner) {
      const result = await sb.rpc("sp_unregister_push", {
        p_endpoint: sub.endpoint
      });

      if (result.error) throw result.error;
    }

    await sub.unsubscribe();
    await announceIdentity(null);
  }

  window.spBeforeLogout = async () => {
    try {
      await unsubscribeAndRemove(
        user()?.id || authUserId
      );
    } catch (e) {
      console.warn("Push cleanup failed:", e);
      status("退出前通知解绑失败，请检查设备订阅");
    }
  };

  window.spSetQuiet = async enabled => {
    localStorage.setItem(
      quietKey,
      enabled ? "1" : "0"
    );

    if (enabled) {
      await window.spDisablePush();
    } else {
      await window.spPushStatus();
    }
  };

  window.spEnablePush = async () => {
    try {
      const u = user();

      if (!u) {
        throw Error("请先登录");
      }

      if (quiet()) {
        throw Error("请先关闭免打扰");
      }

      if (!supports()) {
        throw Error(
          "设备暂不支持 Web Push；iPhone/iPad 请从主屏幕打开"
        );
      }

      const key = window.SAME_PLACE_VAPID_PUBLIC_KEY;

      if (
        !key ||
        key === "PASTE_PUBLIC_VAPID_KEY_HERE"
      ) {
        throw Error("管理员还没有配置推送公钥");
      }

      if (
        await Notification.requestPermission() !==
        "granted"
      ) {
        throw Error("请允许系统通知");
      }

      const r = await navigator.serviceWorker.register(
        workerURL.href,
        { scope: root.pathname }
      );

      await navigator.serviceWorker.ready;

      let sub = await r.pushManager.getSubscription();

      if (!sub) {
        sub = await r.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: bytes(key)
        });
      }

      const row = sub.toJSON();

      if (!row.keys?.p256dh || !row.keys?.auth) {
        throw Error("推送密钥读取失败");
      }

      const { error } = await sb.rpc(
        "sp_register_push",
        {
          p_endpoint: sub.endpoint,
          p_p256dh: row.keys.p256dh,
          p_auth: row.keys.auth,
          p_user_agent: navigator.userAgent.slice(0, 240)
        }
      );

      if (error) throw error;

      await announceIdentity(u.id);

      status("✅ 本设备已订阅通知");

      if (typeof toast === "function") {
        toast("设备通知已开启");
      }
    } catch (e) {
      status("开启失败：" + e.message);

      if (typeof toast === "function") {
        toast(e.message);
      }
    }
  };

  window.spDisablePush = async () => {
    try {
      await unsubscribeAndRemove(
        user()?.id || authUserId
      );

      status("本设备通知已关闭");

      if (typeof toast === "function") {
        toast("设备通知已关闭");
      }
    } catch (e) {
      status("关闭失败：" + e.message);
    }
  };

  window.spPushStatus = async () => {
    if ($("spQuiet")) {
      $("spQuiet").checked = quiet();
    }

    if (!supports()) {
      status(
        "当前环境不支持后台推送；站内提醒仍可使用"
      );
      return;
    }

    try {
      const r = await registration();
      const sub = await r?.pushManager.getSubscription();

      status(
        sub
          ? "已存在设备订阅（需检查服务端配置）"
          : "本设备尚未订阅通知"
      );
    } catch {
      status("无法读取设备订阅状态");
    }
  };

  navigator.serviceWorker?.addEventListener(
    "message",
    e => {
      if (
        e.data?.kind !== "SP_PUSH_FOREGROUND"
      ) {
        return;
      }

      const reply = ok => {
        try {
          e.ports?.[0]?.postMessage({
            handled: !!ok
          });
        } catch {}
      };

      const r = e.data.record;

      if (
        !user() ||
        quiet() ||
        document.visibilityState !== "visible" ||
        r?.receiver_id !== user().id
      ) {
        reply(false);
        return;
      }

      incoming(r)
        .then(reply)
        .catch(() => reply(false));
    }
  );

  async function openDeepLink() {
    if (pendingLink || !user()) return;

    const q = new URLSearchParams(location.search);

    const spaceId = q.get("space_id");
    const senderId = q.get("dm");

    if (!spaceId || !senderId) return;

    if (
      !/^[0-9a-f-]{36}$/i.test(spaceId) ||
      !/^[0-9a-f-]{36}$/i.test(senderId)
    ) {
      return;
    }

    pendingLink = true;

    try {
      await jump({
        space_id: spaceId,
        sender_id: senderId
      });

      const clean = new URL(location.href);

      clean.searchParams.delete("space_id");
      clean.searchParams.delete("dm");

      history.replaceState(null, "", clean);
    } finally {
      pendingLink = false;
    }
  }

  function setup() {
    if (typeof sb === "undefined") {
      setTimeout(setup, 150);
      return;
    }

    sb.auth.getUser()
      .then(async ({ data }) => {
        authUserId = data.user?.id || null;

        connect(authUserId);

        if (authUserId) {
          await announceIdentity(authUserId);
        }

        spPushStatus();
      })
      .catch(console.warn);

    sb.auth.onAuthStateChange((event, session) => {
      setTimeout(async () => {
        const next = session?.user?.id || null;
        const prior = authUserId;

        authUserId = next;

        connect(next);

        if (prior && next !== prior) {
          try {
            await unsubscribeAndRemove(prior);
          } catch (e) {
            console.warn(
              "Push account switch cleanup:",
              e
            );
          }
        }

        if (next) {
          await announceIdentity(next);
          await openDeepLink();
        } else {
          await announceIdentity(null);
        }
      }, 0);
    });

    window.addEventListener("pageshow", () => {
      spPushStatus();
      openDeepLink().catch(console.warn);
    });

    const poll = setInterval(() => {
      if (user()) {
        clearInterval(poll);
        openDeepLink().catch(console.warn);
      }
    }, 500);

    setTimeout(() => clearInterval(poll), 30000);
  }

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      setup
    );
  } else {
    setup();
  }
})();
