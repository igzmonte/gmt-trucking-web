import hashlib
from django.contrib.auth.hashers import BasePasswordHasher, constant_time_compare


class LegacySHA256PasswordHasher(BasePasswordHasher):
    algorithm = "legacy_sha256"

    def salt(self):
        return ""

    def encode(self, password, salt=""):
        if password is None:
            raise TypeError("password must not be None")
        return f"{self.algorithm}${hashlib.sha256(password.encode('utf-8')).hexdigest()}"

    def verify(self, password, encoded):
        return constant_time_compare(self.encode(password), encoded)

    def safe_summary(self, encoded):
        return {"algorithm": self.algorithm, "hash": "legacy SHA-256 value"}

    def must_update(self, encoded):
        return True
