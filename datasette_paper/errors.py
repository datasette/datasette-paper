class ConflictError(Exception):
    """Step version doesn't match server's current version (HTTP 409)."""


class BadVersionError(Exception):
    """Version is negative or greater than server's current version (HTTP 400)."""


class GoneError(Exception):
    """Requested version is older than the in-memory tail (HTTP 410)."""
