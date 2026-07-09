from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0001_initial")]

    operations = [
        migrations.AddField(
            model_name="trip",
            name="reference_no",
            field=models.CharField(blank=True, max_length=100),
        ),
    ]
