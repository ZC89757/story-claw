import test from "node:test";
import assert from "node:assert/strict";
import {titleHasStarted} from "../src/title/evaluate";
import {assertTitleSpec, validateTitleSpec} from "../src/title/validate";

const spec = assertTitleSpec({text: "英伟达：从芯片设计到AI基础设施", at: 5, sequence: 1});

test("title remains hidden until its timestamp", () => {
  assert.equal(titleHasStarted(spec, 4.999), false);
  assert.equal(titleHasStarted(spec, 5), true);
});

test("title schema exposes only text, at and sequence", () => {
  assert.deepEqual(Object.keys(spec).sort(), ["at", "sequence", "text"]);
});

test("title validator rejects invalid sequence", () => {
  assert.ok(validateTitleSpec({...spec, sequence: 0}).length > 0);
});
