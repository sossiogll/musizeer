"""installed_providers: how the current approval came, and the digest it replaced

Revision ID: 0047_provider_update_record
Revises: 0046_working_folder_legacy
Create Date: 2026-11-27

ADR-0007 §5.1. Providers update by themselves when their catalog offers a compatible digest that asks for exactly what
the admin approved, and such an update is recorded as approved by the automatic update: what, from, to and when. The row
already says what and when (``name``, ``digest``, ``approved_at``); it gains

- ``approved_automatically``: the current digest was applied by the automatic update, not approved by an admin;
- ``previous_digest``: the digest the last update replaced (NULL: never updated since it was installed).

Existing rows were installed or approved by an admin: they start as not automatic and with no previous digest.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0047_provider_update_record"
down_revision: Union[str, None] = "0046_working_folder_legacy"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# ADR-0007 section 4: what this migration is for the release that ships it (docs/migrations.md).
phase = "expand"  # adds two columns, one nullable and one with a server default


def upgrade() -> None:
    with op.batch_alter_table("installed_providers") as batch:
        batch.add_column(sa.Column("approved_automatically", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column("previous_digest", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("installed_providers") as batch:
        batch.drop_column("previous_digest")
        batch.drop_column("approved_automatically")
