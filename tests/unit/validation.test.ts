import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError, validate } from "../../src/common.js";

describe("request validation", () => {
  it("accepts a valid UUID", () => {
    expect(validate(z.string().uuid(), "00000000-0000-4000-8000-000000000001")).toBe("00000000-0000-4000-8000-000000000001");
  });
  it("rejects invalid input with a client error", () => {
    try { validate(z.object({ text: z.string().min(1) }), { text: "" }); throw new Error("expected validation error"); }
    catch (error) { expect(error).toBeInstanceOf(AppError); expect((error as AppError).status).toBe(400); }
  });
});
