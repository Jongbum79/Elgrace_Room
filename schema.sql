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
