from __future__ import annotations

import json
from base64 import b64decode, b64encode

from itsdangerous.exc import BadSignature
from starlette.datastructures import MutableHeaders
from starlette.middleware.sessions import Session, SessionMiddleware
from starlette.requests import HTTPConnection
from starlette.types import Message, Receive, Scope, Send


class SchemeAwareSessionMiddleware(SessionMiddleware):
    """Secure cookies on HTTPS (nginx), not on raw http://127.0.0.1."""

    def __init__(self, *args, https_only: bool = False, **kwargs) -> None:
        self._secure_on_https = https_only
        super().__init__(*args, https_only=False, **kwargs)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        connection = HTTPConnection(scope)
        flags = self.security_flags
        if self._secure_on_https and connection.url.scheme == "https":
            flags = f"{flags}; secure"

        initial_session_was_empty = True
        if self.session_cookie in connection.cookies:
            data = connection.cookies[self.session_cookie].encode("utf-8")
            try:
                data = self.signer.unsign(data, max_age=self.max_age)
                scope["session"] = Session(json.loads(b64decode(data)))
                initial_session_was_empty = False
            except BadSignature:
                scope["session"] = Session()
        else:
            scope["session"] = Session()

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                session: Session = scope["session"]
                headers = MutableHeaders(scope=message)
                if session.accessed:
                    headers.add_vary_header("Cookie")
                if session.modified and session:
                    payload = b64encode(json.dumps(session).encode("utf-8"))
                    payload = self.signer.sign(payload)
                    header_value = (
                        "{session_cookie}={data}; path={path}; {max_age}{security_flags}".format(
                            session_cookie=self.session_cookie,
                            data=payload.decode("utf-8"),
                            path=self.path,
                            max_age=f"Max-Age={self.max_age}; " if self.max_age else "",
                            security_flags=flags,
                        )
                    )
                    headers.append("Set-Cookie", header_value)
                elif session.modified and not initial_session_was_empty:
                    header_value = (
                        "{session_cookie}={data}; path={path}; {expires}{security_flags}".format(
                            session_cookie=self.session_cookie,
                            data="null",
                            path=self.path,
                            expires="expires=Thu, 01 Jan 1970 00:00:00 GMT; ",
                            security_flags=flags,
                        )
                    )
                    headers.append("Set-Cookie", header_value)
            await send(message)

        await self.app(scope, receive, send_wrapper)
