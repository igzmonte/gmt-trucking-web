import os

from django.contrib.auth.models import Group, User
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction


ROLES = ("admin", "encoder", "viewer", "accounting")


class Command(BaseCommand):
    help = "Create hosted role groups and the first administrator from environment secrets"

    @transaction.atomic
    def handle(self, *args, **options):
        username = os.environ.get("GMT_ADMIN_USERNAME", "").strip()
        password = os.environ.get("GMT_ADMIN_PASSWORD", "")
        email = os.environ.get("GMT_ADMIN_EMAIL", "").strip()
        preview_password = os.environ.get("GMT_PREVIEW_ROLE_PASSWORD", "")
        if not username or not password:
            raise CommandError("GMT_ADMIN_USERNAME and GMT_ADMIN_PASSWORD are required")
        if len(password) < 12:
            raise CommandError("GMT_ADMIN_PASSWORD must contain at least 12 characters")

        groups = {name: Group.objects.get_or_create(name=name)[0] for name in ROLES}
        user, created = User.objects.get_or_create(
            username=username,
            defaults={"email": email, "is_active": True},
        )
        user.email = email
        user.is_active = True
        user.is_staff = True
        user.is_superuser = True
        if created:
            user.set_password(password)
        user.save()
        user.groups.set([groups["admin"]])
        action = "created" if created else "verified"
        self.stdout.write(self.style.SUCCESS(f"Hosted administrator {action}; no secret values were printed."))

        if preview_password:
            if len(preview_password) < 12:
                raise CommandError("GMT_PREVIEW_ROLE_PASSWORD must contain at least 12 characters")
            for role in ("encoder", "viewer", "accounting"):
                preview_user, preview_created = User.objects.get_or_create(
                    username=f"preview_{role}",
                    defaults={"is_active": True},
                )
                preview_user.is_active = True
                preview_user.is_staff = False
                preview_user.is_superuser = False
                if preview_created:
                    preview_user.set_password(preview_password)
                preview_user.save()
                preview_user.groups.set([groups[role]])
            self.stdout.write(
                self.style.SUCCESS("Hosted Encoder, Viewer, and Accounting preview accounts verified.")
            )
