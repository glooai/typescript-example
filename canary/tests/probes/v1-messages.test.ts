import { expect, it } from "vitest";
import {
  assessV1,
  type V1MessagesFixture,
} from "../../src/probes/v1-messages.js";

const FIXTURE: V1MessagesFixture = {
  signature: "v1/test",
  label: "V1 · test",
  model: "some-model",
  prompt: "hi",
  benign: true,
};

it("marks a non-2xx response as RED FAIL", () => {
  const out = assessV1(
    FIXTURE,
    500,
    '{"detail":"Error generating response."}',
    Date.now() - 1
  );
  expect(out.verdict).toBe("FAIL");
  expect(out.severity).toBe("RED");
  expect(out.httpStatus).toBe(500);
});

it("marks HTTP 200 with empty completion as RED EMPTY_COMPLETION", () => {
  const body = JSON.stringify({
    choices: [{ message: { content: "" } }],
  });
  const out = assessV1(FIXTURE, 200, body, Date.now() - 1);
  expect(out.verdict).toBe("EMPTY_COMPLETION");
  expect(out.severity).toBe("RED");
});

it("marks invalid JSON as SCHEMA_MISMATCH RED", () => {
  const out = assessV1(FIXTURE, 200, "<html>oops</html>", Date.now() - 1);
  expect(out.verdict).toBe("SCHEMA_MISMATCH");
  expect(out.severity).toBe("RED");
});

it("marks a valid response as GREEN PASS", () => {
  const body = JSON.stringify({
    choices: [{ message: { content: "Here are three best practices: …" } }],
  });
  const out = assessV1(FIXTURE, 200, body, Date.now() - 1);
  expect(out.verdict).toBe("PASS");
  expect(out.severity).toBe("GREEN");
  expect(out.contentPreview).toContain("three best practices");
});

it("flags refusal regressions on benign prompts as RED", () => {
  const body = JSON.stringify({
    choices: [
      {
        message: {
          content: "I can't help with that — it looks like unsafe drug use.",
        },
      },
    ],
  });
  const out = assessV1(FIXTURE, 200, body, Date.now() - 1);
  expect(out.verdict).toBe("REFUSAL_REGRESSION");
  expect(out.severity).toBe("RED");
  expect(out.details.matchedPatterns).toBeDefined();
});

it("does not flag refusals when the fixture is not benign", () => {
  const nonBenign = { ...FIXTURE, benign: false };
  const body = JSON.stringify({
    choices: [{ message: { content: "I can't help with unsafe drug use." } }],
  });
  const out = assessV1(nonBenign, 200, body, Date.now() - 1);
  expect(out.verdict).toBe("PASS");
});
