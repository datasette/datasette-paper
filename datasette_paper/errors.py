"""Domain errors raised by ``Instance`` and mapped to HTTP by the routes.

Each :class:`PaperProtocolError` subclass carries its own ``status`` and
``reason`` so a handler can answer with one ``except`` clause instead of
re-deriving the mapping per route. :class:`InvalidStepError` is the one
that also needs a structured JSON body; routes special-case it first.
"""

from typing import ClassVar


class PaperProtocolError(Exception):
    """Base for collab-protocol failures with a fixed HTTP status."""

    status: ClassVar[int]
    #: Plain-text response body / status reason.
    reason: ClassVar[str]

    def __init__(self, message: str = "") -> None:
        super().__init__(message or self.reason)


class ConflictError(PaperProtocolError):
    """Step version doesn't match server's current version (HTTP 409)."""

    status = 409
    reason = "Version not current"


class BadVersionError(PaperProtocolError):
    """Version is negative or greater than server's current version (HTTP 400)."""

    status = 400
    reason = "Invalid version"


class GoneError(PaperProtocolError):
    """Requested version is older than the in-memory tail (HTTP 410)."""

    status = 410
    reason = "History gone"


class InvalidStepError(PaperProtocolError):
    """A step in the POST body could not be applied to the current doc (HTTP 422).

    Carries the 0-based index of the offending step within the request
    batch and the underlying error message so the client can report a
    specific failure and stop sending.
    """

    status = 422
    reason = "Invalid step"

    def __init__(self, step_index: int, message: str) -> None:
        super().__init__(f"step {step_index}: {message}")
        self.step_index = step_index
        self.message = message
