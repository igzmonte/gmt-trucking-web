#!/usr/bin/env bash
set -o errexit

python -m pip install -r requirements-web.txt
python webapp/manage.py check
python webapp/manage.py collectstatic --no-input
python webapp/manage.py migrate --noinput
