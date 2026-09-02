import test from "node:test";
import assert from "node:assert/strict";

import {
  progressPercent,
  shouldShowAvailableVersion,
} from "../public/update-state.js";

test("更新下载进度限制在有效百分比范围内", () => {
  assert.equal(progressPercent(25, 100), 25);
  assert.equal(progressPercent(150, 100), 100);
  assert.equal(progressPercent(-10, 100), 0);
});

test("未知安装包大小使用不确定进度", () => {
  assert.equal(progressPercent(20, null), null);
  assert.equal(progressPercent(20, 0), null);
});

test("仅在存在待安装版本时显示可用版本标题", () => {
  assert.equal(shouldShowAvailableVersion("available", "0.0.24"), true);
  assert.equal(shouldShowAvailableVersion("downloading", "0.0.24"), true);
  assert.equal(shouldShowAvailableVersion("installing", "0.0.24"), true);
  assert.equal(shouldShowAvailableVersion("latest", "0.0.23"), false);
  assert.equal(shouldShowAvailableVersion("available", ""), false);
});
