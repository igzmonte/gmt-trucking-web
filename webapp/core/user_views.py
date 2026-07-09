import csv

from django.contrib import messages
from django.contrib.auth.models import Group, User
from django.core.exceptions import PermissionDenied
from django.core.paginator import Paginator
from django.db.models import Q
from django.http import HttpResponse
from django.shortcuts import get_object_or_404, redirect, render

from .access import page_access
from .user_forms import ROLE_CHOICES, UserManagementForm, UserPasswordForm, active_admin_count, user_app_role


PAGE = "User Management"


def _users_queryset(request):
    rows = User.objects.prefetch_related("groups").order_by("username", "id")
    query = request.GET.get("q", "").strip()
    role = request.GET.get("role", "").strip()
    active = request.GET.get("active", "").strip()
    if query:
        rows = rows.filter(Q(username__icontains=query) | Q(first_name__icontains=query) | Q(last_name__icontains=query) | Q(email__icontains=query))
    if role in dict(ROLE_CHOICES):
        if role == "admin":
            rows = rows.filter(Q(is_superuser=True) | Q(groups__name="admin")).distinct()
        else:
            rows = rows.filter(groups__name=role)
    if active == "active":
        rows = rows.filter(is_active=True)
    elif active == "inactive":
        rows = rows.filter(is_active=False)
    return rows, query, role, active


@page_access(PAGE)
def user_list(request):
    if request.method != "GET":
        raise PermissionDenied
    rows, query, role, active = _users_queryset(request)
    return render(request, "core/user_list.html", {
        "page_title": "User Management",
        "page_obj": Paginator(rows, 25).get_page(request.GET.get("page")),
        "query": query, "selected_role": role, "selected_active": active,
        "role_choices": ROLE_CHOICES,
    })


@page_access(PAGE)
def user_new(request):
    form = UserManagementForm(request.POST or None, current_user=request.user)
    if request.method == "POST" and form.is_valid():
        user = form.save()
        messages.success(request, f"User {user.username} created.")
        return redirect("users_list")
    return render(request, "core/user_form.html", {"page_title": "New User", "form": form, "editing": False})


@page_access(PAGE)
def user_edit(request, pk):
    user = get_object_or_404(User.objects.prefetch_related("groups"), pk=pk)
    form = UserManagementForm(request.POST or None, instance=user, current_user=request.user)
    if request.method == "POST" and form.is_valid():
        saved = form.save()
        messages.success(request, f"User {saved.username} updated.")
        return redirect("users_list")
    return render(request, "core/user_form.html", {"page_title": f"Edit User {user.username}", "form": form, "editing": True, "record": user})


@page_access(PAGE)
def user_password(request, pk):
    user = get_object_or_404(User, pk=pk)
    form = UserPasswordForm(request.POST or None, user=user)
    if request.method == "POST" and form.is_valid():
        user.set_password(form.cleaned_data["password"])
        user.save(update_fields=["password"])
        messages.success(request, f"Password reset for {user.username}.")
        return redirect("users_list")
    return render(request, "core/user_password.html", {"page_title": f"Reset Password: {user.username}", "form": form, "record": user})


@page_access(PAGE)
def user_deactivate(request, pk):
    if request.method != "POST":
        raise PermissionDenied
    user = get_object_or_404(User, pk=pk)
    if user.pk == request.user.pk:
        messages.error(request, "You cannot deactivate your own account.")
    elif user.is_active and user_app_role(user) == "admin" and active_admin_count(exclude_user=user) <= 0:
        messages.error(request, "At least one active admin must remain.")
    else:
        user.is_active = False
        user.save(update_fields=["is_active"])
        messages.success(request, f"User {user.username} deactivated.")
    return redirect("users_list")


@page_access(PAGE)
def user_export(request):
    rows, _, _, _ = _users_queryset(request)
    response = HttpResponse(content_type="text/csv; charset=utf-8")
    response["Content-Disposition"] = 'attachment; filename="users.csv"'
    writer = csv.writer(response)
    writer.writerow(("ID", "Username", "First Name", "Last Name", "Email", "Role", "Active", "Staff", "Superuser"))
    for user in rows:
        writer.writerow((user.pk, user.username, user.first_name, user.last_name, user.email, user_app_role(user), user.is_active, user.is_staff, user.is_superuser))
    return response
