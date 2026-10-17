-- ═══════════════════════════════════════════════════════════════
--  Blink — migration 002: groups, "Save in chat", caption position
--
--  ONLY for projects that already ran the ORIGINAL schema.sql.
--  (Brand-new project? Just run schema.sql — it already includes all of this.)
--  Paste into Supabase → SQL Editor → New query → Run. Run it once.
-- ═══════════════════════════════════════════════════════════════

-- ── Groups ─────────────────────────────────────────────────────
create table public.groups (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 40),
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.group_members (
  group_id  uuid not null references public.groups(id) on delete cascade,
  user_id   uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index group_members_user_idx on public.group_members (user_id);

-- ── New message columns ────────────────────────────────────────
alter table public.messages
  add column group_id uuid references public.groups(id) on delete cascade,
  add column batch_id uuid,
  add column cap_y    real not null default 0.6 check (cap_y between 0 and 1),
  add column saved_at timestamptz;
alter table public.messages add constraint messages_group_batch_check check ((group_id is null) = (batch_id is null));
create index messages_group_idx on public.messages (group_id, created_at desc);

-- ── Functions ──────────────────────────────────────────────────
create function public.is_group_member(g uuid, u uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.group_members where group_id = g and user_id = u);
$$;

create function public.save_snap(p_id uuid, p_path text) returns void
language sql security definer set search_path = public as $$
  update public.messages set media_path = p_path, saved_at = now()
  where id = p_id and recipient = auth.uid() and kind <> 'text'
    and opened_at is not null and saved_at is null
    and p_path like auth.uid()::text || '/%';
$$;

-- 1-to-1 read receipts must no longer touch group messages
create or replace function public.mark_read(p_friend uuid) returns void
language sql security definer set search_path = public as $$
  update public.messages set read_at = now()
  where sender = p_friend and recipient = auth.uid() and group_id is null
    and kind = 'text' and read_at is null;
$$;

create function public.mark_read_group(p_group uuid) returns void
language sql security definer set search_path = public as $$
  update public.messages set read_at = now()
  where group_id = p_group and recipient = auth.uid() and kind = 'text' and read_at is null;
$$;

create function public.create_group(p_name text, p_members uuid[]) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  gid uuid; m uuid; ids uuid[]; n int;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if char_length(trim(coalesce(p_name, ''))) = 0 then raise exception 'Give the group a name.'; end if;
  select coalesce(array_agg(distinct x), '{}') into ids from unnest(p_members) x where x <> auth.uid();
  n := coalesce(array_length(ids, 1), 0);
  if n < 2 then raise exception 'Pick at least 2 friends.'; end if;
  if n > 9 then raise exception 'Groups can have up to 10 people.'; end if;
  foreach m in array ids loop
    if not public.are_friends(auth.uid(), m) then raise exception 'You can only add your friends to a group.'; end if;
  end loop;
  insert into public.groups (name, created_by) values (left(trim(p_name), 40), auth.uid()) returning id into gid;
  insert into public.group_members (group_id, user_id) values (gid, auth.uid());
  insert into public.group_members (group_id, user_id) select gid, unnest(ids);
  return gid;
end;
$$;

revoke execute on function
  public.save_snap(uuid, text), public.mark_read_group(uuid), public.create_group(text, uuid[]), public.is_group_member(uuid, uuid)
  from public, anon;
grant execute on function
  public.save_snap(uuid, text), public.mark_read_group(uuid), public.create_group(text, uuid[]), public.is_group_member(uuid, uuid)
  to authenticated;

create function public.cleanup_empty_group() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.groups g
  where g.id = old.group_id
    and not exists (select 1 from public.group_members where group_id = old.group_id);
  return old;
end;
$$;
create trigger on_member_left
  after delete on public.group_members
  for each row execute function public.cleanup_empty_group();

-- ── Row Level Security ─────────────────────────────────────────
alter table public.groups        enable row level security;
alter table public.group_members enable row level security;

create policy "groups: read"        on public.groups for select to authenticated
  using (public.is_group_member(id, auth.uid()));
create policy "group_members: read" on public.group_members for select to authenticated
  using (public.is_group_member(group_id, auth.uid()));
create policy "group_members: leave" on public.group_members for delete to authenticated
  using (user_id = auth.uid());

drop policy "messages: send" on public.messages;
create policy "messages: send" on public.messages for insert to authenticated
  with check (
    sender = auth.uid()
    and opened_at is null and read_at is null and saved_at is null
    and (media_path is null or media_path like sender::text || '/%')
    and (
      (group_id is null and public.are_friends(sender, recipient))
      or (group_id is not null and public.is_group_member(group_id, sender) and public.is_group_member(group_id, recipient))
    )
  );

-- ── Storage policies (saved snaps; delete-before-open) ─────────
drop policy "snaps: read" on storage.objects;
create policy "snaps: read" on storage.objects for select to authenticated
  using (
    bucket_id = 'snaps' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (select 1 from public.messages m
                 where m.media_path = name
                   and ((m.recipient = auth.uid() and m.opened_at is null)
                        or (m.saved_at is not null and (m.sender = auth.uid() or m.recipient = auth.uid()))))
    )
  );

drop policy "snaps: delete" on storage.objects;
create policy "snaps: delete" on storage.objects for delete to authenticated
  using (
    bucket_id = 'snaps' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (select 1 from public.messages m
                 where m.media_path = name and m.recipient = auth.uid())
    )
  );

-- ── Realtime ───────────────────────────────────────────────────
alter publication supabase_realtime add table public.groups, public.group_members;
