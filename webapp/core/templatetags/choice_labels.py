from django import template

from core.choice_labels import choice_label


register = template.Library()


@register.filter
def dropdown_label(value):
    return choice_label(value)
