/**
 * 通道模板渲染单元测试
 *
 * 覆盖 7 种通知通道（generic/telegram/bark/serverchan/lark/wecom/slack）
 * 的 payload 模板正确性；backup 类型走 backup.ts 不在此测。
 */

import { describe, it, expect } from "vitest";
import { renderNotificationRequest } from "../notification-channels";
import type { NotificationChannel } from "../notification-types";

function makeChannel(type: NotificationChannel["type"], url = "https://x", options: Record<string, string> = {}): NotificationChannel {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "test",
    type,
    url,
    enabled: true,
    options,
    headers: {},
  };
}

describe("renderNotificationRequest", () => {
  it("generic 通道产出 {event,title,body,timestamp}", () => {
    const r = renderNotificationRequest({
      title: "T",
      body: "B",
      event: "key_banned",
      channel: makeChannel("generic"),
    })!;
    const p = JSON.parse(r.body);
    expect(p.event).toBe("key_banned");
    expect(p.title).toBe("T");
    expect(p.body).toBe("B");
    expect(typeof p.timestamp).toBe("number");
  });

  it("telegram：chatId 来自 options，不带则省略字段", () => {
    const r = renderNotificationRequest({
      title: "T",
      body: "B",
      event: "key_banned",
      channel: makeChannel("telegram", "https://api.telegram.org/bot123/sendMessage", { chatId: "999" }),
    })!;
    const p = JSON.parse(r.body);
    expect(p.chat_id).toBe("999");
    expect(p.text).toContain("T");
    expect(p.text).toContain("B");
  });

  it("telegram：无 chatId 时只发 text", () => {
    const r = renderNotificationRequest({
      title: "T", body: "B", event: "key_banned", channel: makeChannel("telegram"),
    })!;
    const p = JSON.parse(r.body);
    expect(p.chat_id).toBeUndefined();
    expect(p.text).toBeDefined();
  });

  it("bark：title/body 必有，group/level/icon 仅当 options 提供", () => {
    const r = renderNotificationRequest({
      title: "T", body: "B", event: "key_banned",
      channel: makeChannel("bark", "https://api.day.app/key", { group: "fwp", level: "active" }),
    })!;
    const p = JSON.parse(r.body);
    expect(p.title).toBe("T");
    expect(p.body).toBe("B");
    expect(p.group).toBe("fwp");
    expect(p.level).toBe("active");
  });

  it("serverchan：title + desp", () => {
    const r = renderNotificationRequest({
      title: "T", body: "B", event: "key_banned",
      channel: makeChannel("serverchan", "https://sctapi.ftqq.com/key.send", { short: "detail", channel: "9" }),
    })!;
    const p = JSON.parse(r.body);
    expect(p.title).toBe("T");
    expect(p.desp).toBe("B");
    expect(p.short).toBe("detail");
    expect(p.channel).toBe("9");
  });

  it("lark：msg_type=text + content.text", () => {
    const r = renderNotificationRequest({
      title: "T", body: "B", event: "key_banned", channel: makeChannel("lark"),
    })!;
    const p = JSON.parse(r.body);
    expect(p.msg_type).toBe("text");
    expect(p.content.text).toContain("T");
    expect(p.content.text).toContain("B");
  });

  it("wecom：msgtype=text + text.content", () => {
    const r = renderNotificationRequest({
      title: "T", body: "B", event: "key_banned", channel: makeChannel("wecom"),
    })!;
    const p = JSON.parse(r.body);
    expect(p.msgtype).toBe("text");
    expect(p.text.content).toContain("T");
    expect(p.text.content).toContain("B");
  });

  it("slack：text 字段加粗标题", () => {
    const r = renderNotificationRequest({
      title: "T", body: "B", event: "key_banned", channel: makeChannel("slack"),
    })!;
    const p = JSON.parse(r.body);
    expect(p.text).toContain("*T*");
    expect(p.text).toContain("B");
  });

  it("backup 通道不通过 renderNotificationRequest", () => {
    const r = renderNotificationRequest({
      title: "T", body: "B", event: "key_banned", channel: makeChannel("backup"),
    });
    expect(r).toBeNull();
  });

  it("自定义 headers 合并到默认 headers（覆盖默认）", () => {
    const ch = makeChannel("generic");
    ch.headers = { "X-Token": "abc", "User-Agent": "custom-ua/1.0" };
    const r = renderNotificationRequest({
      title: "T", body: "B", event: "key_banned", channel: ch,
    })!;
    expect(r.headers["X-Token"]).toBe("abc");
    expect(r.headers["User-Agent"]).toBe("custom-ua/1.0");
    expect(r.headers["Content-Type"]).toBe("application/json");
  });
});
