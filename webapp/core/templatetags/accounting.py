from decimal import Decimal, InvalidOperation

from django import template


register = template.Library()


@register.filter
def accounting(value, style=""):
    try:
        amount = Decimal(str(value or 0))
    except (InvalidOperation, TypeError, ValueError):
        amount = Decimal("0")
    force_parentheses = str(style).lower() in {"deduction", "negative", "parentheses"}
    if amount == 0:
        return "₱ -"
    rendered = f"₱ {abs(amount):,.2f}"
    return f"({rendered})" if amount < 0 or force_parentheses else rendered
