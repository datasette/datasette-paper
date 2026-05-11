class ConflictError(Exception):
    """Step version doesn't match server's current version (HTTP 409)."""


class BadVersionError(Exception):
    """Version is negative or greater than server's current version (HTTP 400)."""


class GoneError(Exception):
    """Requested version is older than the in-memory tail (HTTP 410)."""


class InvalidStepError(Exception):
    """A step in the POST body could not be applied to the current doc (HTTP 422).

    Carries the 0-based index of the offending step within the request
    batch and the underlying error message so the client can report a
    specific failure and stop sending.
    """

    def __init__(self, step_index: int, message: str) -> None:
        super().__init__(f"step {step_index}: {message}")
        self.step_index = step_index
        self.message = message
