/** Wraps an async Express handler so a rejected promise reaches errorHandler instead of hanging the request. */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { asyncHandler };
