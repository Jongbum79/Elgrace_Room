-- 주은혜교회 공간예약시스템 데이터베이스 스키마
-- Supabase 대시보드 -> SQL Editor에서 아래 쿼리를 실행하십시오.

-- 1. room_reservations 테이블 생성
CREATE TABLE IF NOT EXISTS public.room_reservations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    room_id text NOT NULL,                -- PPTX 도형 ID (예: '직사각형_10')
    room_name text NOT NULL,              -- 공간 이름 (예: '교육관 1')
    date date NOT NULL,                   -- 예약 날짜 (YYYY-MM-DD)
    start_time text NOT NULL,             -- 시작 시간 (예: '09:00')
    end_time text NOT NULL,               -- 종료 시간 (예: '10:30')
    title text NOT NULL,                  -- 사용 목적 (예: '대학부 모임')
    reserved_by text NOT NULL,            -- 예약자 닉네임 (카카오 닉네임)
    user_id text NOT NULL,                -- 카카오 고유 ID 또는 모의 ID
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- 2. 날짜별 조회를 위한 인덱스 생성 (성능 최적화)
CREATE INDEX IF NOT EXISTS idx_room_reservations_date ON public.room_reservations(date);

-- 3. Row Level Security (RLS) 활성화
-- 필요에 따라 보안 정책(Policies)을 추가하여 특정 사용자만 변경할 수 있도록 제한할 수 있습니다.
-- 현재는 누구나 조회 및 삽입이 가능하도록 설정하되, 클라이언트(app.js)에서 본인 확인 후 삭제 요청을 보내도록 처리합니다.
ALTER TABLE public.room_reservations ENABLE ROW LEVEL SECURITY;

-- 4. 기본 정책 정의 (모든 사용자 SELECT/INSERT/DELETE 허용)
CREATE POLICY "Allow public read access" ON public.room_reservations FOR SELECT USING (true);
CREATE POLICY "Allow public insert access" ON public.room_reservations FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public delete access" ON public.room_reservations FOR DELETE USING (true);

-- 5. 같은 공간/날짜에서 시간이 겹치는 예약 방지
-- 여러 사용자가 동시에 예약 버튼을 눌러도 데이터베이스가 최종적으로 중복 예약을 차단합니다.
CREATE OR REPLACE FUNCTION public.time_text_to_minutes(time_text text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (split_part(time_text, ':', 1)::integer * 60) + split_part(time_text, ':', 2)::integer;
$$;

CREATE OR REPLACE FUNCTION public.prevent_overlapping_room_reservations()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF public.time_text_to_minutes(NEW.start_time) >= public.time_text_to_minutes(NEW.end_time) THEN
    RAISE EXCEPTION '예약 종료 시간은 시작 시간보다 늦어야 합니다.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.room_reservations existing
    WHERE existing.room_id = NEW.room_id
      AND existing.date = NEW.date
      AND existing.id <> COALESCE(NEW.id, -1)
      AND public.time_text_to_minutes(NEW.start_time) < public.time_text_to_minutes(existing.end_time)
      AND public.time_text_to_minutes(NEW.end_time) > public.time_text_to_minutes(existing.start_time)
  ) THEN
    RAISE EXCEPTION '이미 예약된 시간대입니다.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_overlapping_room_reservations ON public.room_reservations;
CREATE TRIGGER trg_prevent_overlapping_room_reservations
BEFORE INSERT OR UPDATE ON public.room_reservations
FOR EACH ROW
EXECUTE FUNCTION public.prevent_overlapping_room_reservations();

-- 6. 동시 INSERT 경쟁 상황까지 막는 최종 중복 방지 제약
-- 기존 데이터에 중복 예약이 있으면 제약 추가가 실패하므로, 먼저 중복 데이터를 정리한 뒤 실행하십시오.
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'no_overlapping_room_reservations'
      AND conrelid = 'public.room_reservations'::regclass
  ) THEN
    ALTER TABLE public.room_reservations
      ADD CONSTRAINT no_overlapping_room_reservations
      EXCLUDE USING gist (
        room_id WITH =,
        date WITH =,
        int4range(
          public.time_text_to_minutes(start_time),
          public.time_text_to_minutes(end_time),
          '[)'
        ) WITH &&
      );
  END IF;
END;
$$;

-- 7. Supabase Realtime 변경 이벤트 발행
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'room_reservations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.room_reservations;
  END IF;
END;
$$;
