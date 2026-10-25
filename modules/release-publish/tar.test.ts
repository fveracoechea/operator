import { expect, test } from "bun:test";
import { packTarball } from "./tar.ts";

test("tar output has stable order, exact bytes, fixed modes, and no wall-clock timestamp", () => {
  const entries = [
    { path: "a", bytes: new Uint8Array([255]) },
    { path: "Z", bytes: new TextEncoder().encode("abc"), executable: true },
  ];
  expect(packTarball(entries)).toEqual(packTarball(entries.toReversed()));
  const raw = Bun.gunzipSync(packTarball(entries));
  const text = new TextDecoder();
  expect(text.decode(raw.subarray(0, 2))).toBe("Z\0");
  expect(text.decode(raw.subarray(100, 108))).toBe("0000755\0");
  expect(text.decode(raw.subarray(136, 148))).toBe("00000000000\0");
  expect([...raw.subarray(512, 515)]).toEqual([97, 98, 99]);
  expect(text.decode(raw.subarray(1024, 1026))).toBe("a\0");
  expect(text.decode(raw.subarray(1124, 1132))).toBe("0000644\0");
  expect(raw.length).toBe(3072);
});

test("long paths use the ustar prefix or refuse instead of truncating", () => {
  const path = `${"a".repeat(90)}/${"b".repeat(90)}`;
  const raw = Bun.gunzipSync(packTarball([{ path, bytes: new Uint8Array() }]));
  expect(new TextDecoder().decode(raw.subarray(0, 90))).toBe("b".repeat(90));
  expect(new TextDecoder().decode(raw.subarray(345, 435))).toBe("a".repeat(90));
  expect(() => packTarball([{ path: "a".repeat(300), bytes: new Uint8Array() }])).toThrow(
    "too long",
  );
});
