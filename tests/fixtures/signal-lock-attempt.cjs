/**
 * Preload that reports the moment its process first reaches a file lock.
 *
 * The child in a lock-wait test is the CLI, which has no way to say it is up.
 * Without a signal the test can only give it a window and hope it started inside
 * one — and the window has to cover node startup and module load as well as the
 * work, so a slow start observes nothing and the test passes having tested
 * nothing. Signalling from the first `.gsd-lock` open puts the child past
 * startup, past module load, past dispatch, and inside the acquire loop, where
 * it cannot write until the lock is free. From there the observation needs no
 * clock at all.
 *
 * The coupling is to lock acquisition going through fs.openSync on a
 * `*.gsd-lock` path. If that stops being true the flag never appears and the
 * waiting test fails saying so, which is the direction a coupling like this
 * should fail in.
 *
 * Loaded with `node --require`, with GSD_TEST_LOCK_FLAG naming the file to
 * create.
 */

const fs = require('fs');

const flagPath = process.env.GSD_TEST_LOCK_FLAG;
const realOpenSync = fs.openSync;
let signalled = false;

fs.openSync = function openSync(target, ...rest) {
  if (!signalled && typeof target === 'string' && target.endsWith('.gsd-lock')) {
    // Set before the write: writeFileSync opens a file too, and the flag must
    // not re-enter this branch.
    signalled = true;
    fs.writeFileSync(flagPath, '');
  }
  return realOpenSync.call(fs, target, ...rest);
};
