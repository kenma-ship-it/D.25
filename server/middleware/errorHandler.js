/**
 * Central error handler — the last middleware mounted in server/index.js.
 *
 * Customers never see a stack trace, a file path, or a raw exception
 * message: every unhandled error becomes the same generic, safe message.
 * Full details are logged server-side (stdout here; pipe to a real log
 * aggregator in production) for debugging.
 */
function errorHandler(err, req, res, _next) {
  // eslint-disable-next-line no-console
  console.error(`[error] ${req.method} ${req.path}:`, err && err.stack ? err.stack : err);

  if (res.headersSent) return;

  const statusCode = err && err.statusCode && Number.isInteger(err.statusCode) ? err.statusCode : 500;
  // body-parser failures carry parser internals ("Expected property name at
  // position 1…") in err.message — replace them with fixed wording.
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid request body." });
  if (err && err.type === "entity.too.large") return res.status(413).json({ error: "Request is too large." });
  const safeMessage =
    statusCode < 500 && err && err.message
      ? err.message
      : "Something went wrong on our end. Please try again in a moment.";

  res.status(statusCode).json({ error: safeMessage });
}

function notFoundHandler(req, res) {
  res.status(404).json({ error: "Not found." });
}

module.exports = { errorHandler, notFoundHandler };
