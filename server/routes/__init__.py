"""Route modules (FOUNDATION, frozen list). Importing this package registers every endpoint, in this order."""

from server.routes import core  # noqa: F401
from server.routes import assignments  # noqa: F401
from server.routes import files  # noqa: F401
from server.routes import grading  # noqa: F401
from server.routes import ai_rules  # noqa: F401
from server.routes import ai_runtime  # noqa: F401
from server.routes import telemetry  # noqa: F401
from server.routes import kiwi  # noqa: F401
from server.routes import insights  # noqa: F401
from server.routes import people  # noqa: F401
from server.routes import exports  # noqa: F401
