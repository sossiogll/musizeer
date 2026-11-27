"""root_mappings: what another program calls the library

Revision ID: 0047_root_mappings
Revises: 0046_working_folder_legacy
Create Date: 2026-11-27

ADR-0008, steps 5 and 6. One new table, nothing is backfilled and nothing the previous release reads changes, so the
previous release works on the result:

- ``root_mappings``: for a delegate (a download provider whose external system imports into the library) the folder of
  that system that is the library (``role`` ``writer``, ``remote_path``), and for a sync provider (``role`` ``reader``)
  the outcome of the full-sync verification; each with the library folder it was established against
  (``target_folder``), how (``method``), the outcome (``result``, ``detail``) and when (``verified_at``).

The downgrade drops it.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0047_root_mappings"
down_revision: Union[str, None] = "0046_working_folder_legacy"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# ADR-0007 section 4: what this migration is for the release that ships it (docs/migrations.md).
phase = "expand"  # adds a table


def upgrade() -> None:
    op.create_table(
        "root_mappings",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("provider", sa.String(), nullable=False),
        sa.Column("role", sa.String(), nullable=False),
        sa.Column("remote_path", sa.String(), nullable=False, server_default=""),
        sa.Column("target_folder", sa.String(), nullable=True),
        sa.Column("method", sa.String(), nullable=False),
        sa.Column("result", sa.String(), nullable=False),
        sa.Column("detail", sa.String(), nullable=False, server_default=""),
        sa.Column("verified_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("provider", "role", "remote_path", name="uq_root_mapping"),
    )


def downgrade() -> None:
    op.drop_table("root_mappings")
