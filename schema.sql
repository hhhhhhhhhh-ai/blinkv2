-- ═══════════════════════════════════════════════════════════════
--  Blink — Supabase schema
--  Paste this whole file into  Supabase → SQL Editor → New query → Run.
--  Run it ONCE on a fresh project.
--  (Already ran an older version? Run migrations/002_groups_save_caption.sql instead.)
-- ═══════════════════════════════════════════════════════════════

-- ── Tables ─────────────────────────────────────────────────────
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  username     text not null unique check (username ~ '^[a-z0-9_.]{3,20}$'),
  display_name text not null default '',
  created_at   timestamptz not null default now()
);

create table public.friendships (
  id         uuid primary key default gen_random_uuid(),
  requester  uuid not null references public.profiles(id) on delete cascade,
  addressee  uuid not null references public.profiles(id) on delete cascade,
  status     text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  check (requester <> addressee)
);
-- only one friendship row per pair of people, whoever asked first
create unique index friendships_pair_idx
  on public.friendships (least(requester, addressee), greatest(requester, addressee));

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

-- A message is always addressed to ONE recipient. A group message is stored once per member
-- (same group_id + batch_id), which lets every member open their own copy of a snap exactly once.
create table public.messages (
  id         uuid primary key default gen_random_uuid(),
  sender     uuid not null references public.profiles(id) on delete cascade,
  recipient  uuid not null references public.profiles(id) on delete cascade,
  group_id   uuid references public.groups(id) on delete cascade,        -- null = 1-to-1 chat
  batch_id   uuid,                                                       -- ties together the per-member copies of one group message
  kind       text not null check (kind in ('text', 'image', 'video')),
  body       text not null default '' check (char_length(body) <= 2000), -- chat text, or a snap's caption
  cap_y      real not null default 0.6 check (cap_y between 0 and 1),    -- caption height on the snap (0 = top, 1 = bottom)
  media_path text,                                                       -- file in the 'snaps' bucket
  duration   int  not null default 5 check (duration between 1 and 30), -- seconds a snap can be viewed
  created_at timestamptz not null default now(),
  opened_at  timestamptz,                                                -- snaps: when the recipient opened it
  read_at    timestamptz,                                                -- text: when the recipient read it
  saved_at   timestamptz,                                                -- snaps: recipient kept it in the chat
  check (sender <> recipient),
  check ((group_id is null) = (batch_id is null)),
  check ((kind = 'text' and media_path is null) or (kind <> 'text' and media_path is not null))
);
create index messages_sender_idx    on public.messages (sender, recipient, created_at desc);
create index messages_recipient_idx on public.messages (recipient, created_at desc);
create index messages_group_idx     on public.messages (group_id, created_at desc);

-- ── Helper functions ───────────────────────────────────────────
create function public.are_friends(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester = a and f.addressee = b) or (f.requester = b and f.addressee = a))
  );
$$;

create function public.is_group_member(g uuid, u uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.group_members where group_id = g and user_id = u);
$$;

-- lets the sign-up form say "username taken" before creating the account
create function public.username_available(p_username text) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.profiles where username = lower(p_username));
$$;

-- recipient opens a snap → it can never be fetched again (storage policy below checks opened_at)
create function public.open_snap(p_id uuid) returns void
language sql security definer set search_path = public as $$
  update public.messages set opened_at = now()
  where id = p_id and recipient = auth.uid() and kind <> 'text' and opened_at is null;
$$;

-- recipient keeps a snap in the chat: the app re-uploads it into the recipient's own folder first
create function public.save_snap(p_id uuid, p_path text) returns void
language sql security definer set search_path = public as $$
  update public.messages set media_path = p_path, saved_at = now()
  where id = p_id and recipient = auth.uid() and kind <> 'text'
    and opened_at is not null and saved_at is null
    and p_path like auth.uid()::text || '/%';
$$;

create function public.mark_read(p_friend uuid) returns void
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

-- creates a group and its member list in one go; you can only add your own friends (2–9 of them)
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
  public.open_snap(uuid), public.save_snap(uuid, text), public.mark_read(uuid), public.mark_read_group(uuid),
  public.create_group(text, uuid[]), public.are_friends(uuid, uuid), public.is_group_member(uuid, uuid)
  from public, anon;
grant execute on function
  public.open_snap(uuid), public.save_snap(uuid, text), public.mark_read(uuid), public.mark_read_group(uuid),
  public.create_group(text, uuid[]), public.are_friends(uuid, uuid), public.is_group_member(uuid, uuid)
  to authenticated;
grant execute on function public.username_available(text) to anon, authenticated;

-- ── Create a profile automatically when someone signs up ───────
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, display_name)
  values (
    new.id,
    lower(new.raw_user_meta_data ->> 'username'),
    coalesce(new.raw_user_meta_data ->> 'display_name', '')
  );
  return new;
end;
$$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- when the last member leaves, the group (and its messages) goes away
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

-- ── Row Level Security: who may see / change what ──────────────
alter table public.profiles      enable row level security;
alter table public.friendships   enable row level security;
alter table public.groups        enable row level security;
alter table public.group_members enable row level security;
alter table public.messages      enable row level security;

-- profiles: any signed-in user can look people up by username; you can only edit your own
create policy "profiles: read"        on public.profiles for select to authenticated using (true);
create policy "profiles: update own"  on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- friendships: you see yours, you can ask, only the person asked can accept, either can end it
create policy "friendships: read"   on public.friendships for select to authenticated
  using (requester = auth.uid() or addressee = auth.uid());
create policy "friendships: ask"    on public.friendships for insert to authenticated
  with check (requester = auth.uid() and status = 'pending');
create policy "friendships: accept" on public.friendships for update to authenticated
  using (addressee = auth.uid()) with check (addressee = auth.uid() and status = 'accepted');
create policy "friendships: end"    on public.friendships for delete to authenticated
  using (requester = auth.uid() or addressee = auth.uid());

-- groups: members can see their groups and who is in them; groups are created through create_group(),
-- and you can leave (but not remove other people)
create policy "groups: read"        on public.groups for select to authenticated
  using (public.is_group_member(id, auth.uid()));
create policy "group_members: read" on public.group_members for select to authenticated
  using (public.is_group_member(group_id, auth.uid()));
create policy "group_members: leave" on public.group_members for delete to authenticated
  using (user_id = auth.uid());

-- messages: you see the ones you sent/received. 1-to-1: only to accepted friends.
-- Group: only from a member to another member. A snap's file must live in YOUR own storage folder.
create policy "messages: read" on public.messages for select to authenticated
  using (sender = auth.uid() or recipient = auth.uid());
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
-- (no update/delete policy on messages: opened/read/saved are set only through the functions above)

-- ── Storage: private bucket for snaps ──────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('snaps', 'snaps', false, 52428800,
        array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "snaps: upload to own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'snaps' and (storage.foldername(name))[1] = auth.uid()::text);

-- you can read your own uploads (incl. snaps you saved), a snap sent to you — but only until you've
-- opened it — and a snap that was saved in the chat you share with the sender
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

-- the app deletes a snap's file right after downloading it (before marking it opened).
-- NB: Postgres only lets you delete rows you can also read, so this has to happen while the snap is still unopened.
create policy "snaps: delete" on storage.objects for delete to authenticated
  using (
    bucket_id = 'snaps' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (select 1 from public.messages m
                 where m.media_path = name and m.recipient = auth.uid())
    )
  );

-- ── Realtime: push new messages / friend requests / groups to open apps ─
alter publication supabase_realtime add table
  public.messages, public.friendships, public.groups, public.group_members;
