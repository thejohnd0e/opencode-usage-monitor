# Windows/Bun persistent-cache test limitation

Verified on 2026-11-02 with Bun 1.4.2 on Windows (`process.platform === "win32"`).

## Result

`bun test` ran 322 tests: 307 passed and 15 failed. The failures are confined to
persistent-cache writes:

- 14 tests in `src/__tests__/provider-cache.test.ts` expected
  `status: "written"` but received the intentionally sanitized
  `cache-write-failed` result.
- 1 test in `src/__tests__/refresh-review-blockers.test.ts` received the same
  cache-write failure.

All other tests passed in that run.

## Cause

The cache implementation requires the filesystem's `O_NOFOLLOW` flag when
opening cache files and directories (`src/provider-cache.ts`,
`requiredNoFollowFlag`). On the verified Windows/Bun runtime,
`node:fs.constants.O_NOFOLLOW` is absent. The cache deliberately catches the
resulting write error and returns `cache-write-failed`, so the test output does
not expose the underlying exception.

This is an environment/platform compatibility limitation, not evidence of a
Codex RPC or provider test regression. The full test suite remains non-green on
this runtime; rerun it on a supported POSIX/Bun environment to validate the
persistent-cache cases. Do not weaken the no-follow security requirement just
to make this Windows run pass.

## Verification

```text
Bun 1.4.2 / win32
node:fs.constants.O_NOFOLLOW: undefined
322 tests: 307 pass, 15 fail
```
