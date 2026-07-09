from django import forms
from django.contrib.auth.models import Group, User
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError


ROLE_CHOICES = (
    ("admin", "Admin"),
    ("encoder", "Encoder"),
    ("viewer", "Viewer"),
    ("accounting", "Accounting"),
)


def ensure_role_groups():
    return {name: Group.objects.get_or_create(name=name)[0] for name, _ in ROLE_CHOICES}


def active_admin_count(exclude_user=None):
    users = User.objects.filter(is_active=True)
    if exclude_user:
        users = users.exclude(pk=exclude_user.pk)
    return users.filter(is_superuser=True).count() + users.filter(groups__name="admin").distinct().count()


def user_app_role(user):
    if user.is_superuser:
        return "admin"
    return user.groups.filter(name__in=[name for name, _ in ROLE_CHOICES]).order_by("name").values_list("name", flat=True).first() or ""


class UserManagementForm(forms.ModelForm):
    role = forms.ChoiceField(choices=ROLE_CHOICES)
    password = forms.CharField(widget=forms.PasswordInput, required=False, help_text="Required for new users.")

    class Meta:
        model = User
        fields = ["username", "first_name", "last_name", "email", "role", "is_active", "password"]

    def __init__(self, *args, current_user=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.current_user = current_user
        for field in self.fields.values():
            field.widget.attrs.setdefault("class", "form-control")
        if self.instance and self.instance.pk:
            self.fields.pop("password")
            self.fields["role"].initial = user_app_role(self.instance) or "viewer"
        else:
            self.fields["password"].required = True
            self.fields["is_active"].initial = True

    def clean_username(self):
        username = self.cleaned_data["username"].strip()
        duplicate = User.objects.filter(username__iexact=username)
        if self.instance and self.instance.pk:
            duplicate = duplicate.exclude(pk=self.instance.pk)
        if duplicate.exists():
            raise ValidationError("A user with this username already exists.")
        return username

    def clean_password(self):
        password = self.cleaned_data.get("password") or ""
        if not self.instance.pk or password:
            validate_password(password, self.instance)
        return password

    def clean(self):
        cleaned = super().clean()
        if self.instance and self.instance.pk:
            becoming_inactive = not cleaned.get("is_active")
            role = cleaned.get("role")
            was_admin = user_app_role(self.instance) == "admin"
            if self.current_user and self.instance.pk == self.current_user.pk and becoming_inactive:
                self.add_error("is_active", "You cannot deactivate your own account.")
            if was_admin and (becoming_inactive or role != "admin") and active_admin_count(exclude_user=self.instance) <= 0:
                self.add_error("role", "At least one active admin must remain.")
        return cleaned

    def save(self, commit=True):
        is_new = self.instance.pk is None
        user = super().save(commit=False)
        password = self.cleaned_data.get("password", "")
        if password and is_new:
            user.set_password(password)
        if commit:
            user.save()
            groups = ensure_role_groups()
            user.groups.remove(*Group.objects.filter(name__in=groups.keys()))
            user.groups.add(groups[self.cleaned_data["role"]])
        return user


class UserPasswordForm(forms.Form):
    password = forms.CharField(widget=forms.PasswordInput)
    confirm_password = forms.CharField(widget=forms.PasswordInput)

    def __init__(self, *args, user=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.user = user
        for field in self.fields.values():
            field.widget.attrs.setdefault("class", "form-control")

    def clean(self):
        cleaned = super().clean()
        password = cleaned.get("password")
        if password and password != cleaned.get("confirm_password"):
            self.add_error("confirm_password", "Passwords do not match.")
        if password:
            validate_password(password, self.user)
        return cleaned
