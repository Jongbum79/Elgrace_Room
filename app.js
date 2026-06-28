/**
 * 주은혜교회 공간예약시스템 핵심 Javascript 애플리케이션
 * 
 * - 카카오 SDK 로그인 + 로컬 모의 로그인 연동
 * - Supabase 실시간 연동 (SELECT, INSERT, DELETE)
 * - 일요일 시작 1달 달력 렌더러
 * - SVG 평면도 렌더러 및 인터랙션 (드래그 시간 선택 팝오버)
 * - 시간축 x 공간축 드래그 예약 타임라인 매트릭스
 * - PC & 모바일 반응형 뷰 스위처
 */

// 1. 설정 및 전역 상태 변수
const SUPABASE_URL = "https://jayobvddlaygmgwfkuhv.supabase.co";
const SUPABASE_KEY = "sb_publishable_T2c0JzATeQOwCtqHAb3g1w_v1m22LpN";
const KAKAO_APP_KEY = "a4b38a08f325d15080d80e9979d04ee7"; // 카카오 자바스크립트 키 (입력 시 실연동 작동)

let supabaseClient = null;
let reservationRealtimeChannel = null;
let realtimeRefreshTimer = null;
let roomLayout = null; // room_layout_data.json 저장용
let reservations = []; // Supabase에서 로드된 예약 리스트

// 현재 달력 포커스 월
let currentYear = new Date().getFullYear();
let currentMonth = new Date().getMonth(); // 0-indexed

// 선택된 날짜 및 상태
let selectedDateStr = formatDate(new Date()); 
let currentUser = null;
let currentViewMode = "desktop"; // desktop | mobile

// 시간 슬롯 리스트 (09:00 ~ 21:00, 1시간 단위)
const TIME_SLOTS = [];
for (let h = 9; h < 21; h++) {
  const hourStr = String(h).padStart(2, "0");
  TIME_SLOTS.push(`${hourStr}:00`);
}

function timeToMinutes(timeStr) {
  const [hours, minutes] = timeStr.split(":").map(Number);
  return hours * 60 + minutes;
}

function getSlotStartMinutes(slotIdx) {
  return timeToMinutes(TIME_SLOTS[slotIdx]);
}

function getSlotEndMinutes(slotIdx) {
  if (slotIdx === TIME_SLOTS.length - 1) return timeToMinutes("21:00");
  return timeToMinutes(TIME_SLOTS[slotIdx + 1]);
}

function getSlotEndTime(slotIdx) {
  return slotIdx === TIME_SLOTS.length - 1 ? "21:00" : TIME_SLOTS[slotIdx + 1];
}

function reservationOverlapsSlot(reservation, slotIdx) {
  const slotStart = getSlotStartMinutes(slotIdx);
  const slotEnd = getSlotEndMinutes(slotIdx);
  const reservationStart = timeToMinutes(reservation.start_time);
  const reservationEnd = timeToMinutes(reservation.end_time);
  return reservationStart < slotEnd && reservationEnd > slotStart;
}

function reservationsOverlap(aStartTime, aEndTime, bStartTime, bEndTime) {
  return timeToMinutes(aStartTime) < timeToMinutes(bEndTime) && timeToMinutes(aEndTime) > timeToMinutes(bStartTime);
}

const RESERVATION_OWNER_COLORS = [
  { bg: "#EAF2FB", fg: "#2F65B6", border: "#C4DDFC" },
  { bg: "#FDF4EB", fg: "#C07027", border: "#F5DBBF" },
  { bg: "#E8F1EB", fg: "#2F5F45", border: "#C9DCCD" },
  { bg: "#F1ECFA", fg: "#6D56A5", border: "#D8CAE8" },
  { bg: "#FBEFF3", fg: "#A84D69", border: "#E8C8D3" },
  { bg: "#EEF6F8", fg: "#347486", border: "#C8E0E6" },
  { bg: "#F8F1DD", fg: "#8A6A1F", border: "#E6D6A6" },
  { bg: "#F0F2F8", fg: "#4E5F91", border: "#CDD4E8" }
];

function hashString(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function getReservationOwnerColor(reservation) {
  const ownerKey = reservation.user_id || reservation.reserved_by || "unknown";
  return RESERVATION_OWNER_COLORS[hashString(ownerKey) % RESERVATION_OWNER_COLORS.length];
}

function applyReservationOwnerColor(element, reservation) {
  const color = getReservationOwnerColor(reservation);
  element.style.background = color.bg;
  element.style.color = color.fg;
  element.style.border = `1px solid ${color.border}`;
}

// 2. 초기화 작업
document.addEventListener("DOMContentLoaded", async () => {
  initSupabase();
  initKakao();
  loadUserSession();
  initViewMode();
  setupEventListeners();
  
  // 데이터 로드
  await loadRoomLayout();
  await refreshData();
  
  // 초기 렌더링
  renderAll();
});

// Supabase 클라이언트 초기화
function initSupabase() {
  if (window.supabase) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log("Supabase 초기화 완료");
    subscribeReservationRealtime();
  } else {
    console.error("Supabase SDK를 로드할 수 없습니다.");
  }
}

function subscribeReservationRealtime() {
  if (!supabaseClient || reservationRealtimeChannel) return;
  
  reservationRealtimeChannel = supabaseClient
    .channel("room_reservations_live")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "room_reservations" },
      () => {
        scheduleRealtimeRefresh();
      }
    )
    .subscribe(status => {
      console.log("예약 실시간 구독 상태:", status);
    });
}

function scheduleRealtimeRefresh() {
  clearTimeout(realtimeRefreshTimer);
  realtimeRefreshTimer = setTimeout(async () => {
    await refreshData({ silent: true });
    renderAll();
    showToast("예약 현황이 실시간 갱신되었습니다.");
  }, 250);
}

// 카카오 SDK 초기화
function initKakao() {
  if (window.Kakao) {
    if (KAKAO_APP_KEY) {
      try {
        window.Kakao.init(KAKAO_APP_KEY);
        console.log("Kakao SDK 초기화 완료");
      } catch (e) {
        console.error("Kakao SDK 초기화 에러:", e);
      }
    } else {
      console.log("카카오 API 키가 설정되지 않아 모의 로그인 모드로 작동합니다.");
    }
  }
}

// 뷰 모드 초기화 (기본값 설정 및 토글 세팅)
function initViewMode() {
  const savedMode = localStorage.getItem("reservation-view-mode");
  if (savedMode) {
    currentViewMode = savedMode;
  } else {
    // 화면 크기에 따른 자동 감지
    currentViewMode = window.innerWidth < 768 ? "mobile" : "desktop";
  }
  setViewMode(currentViewMode, false);
}

// 보기 모드 설정 (PC/모바일)
function setViewMode(mode, remember = true) {
  currentViewMode = mode;
  document.body.classList.toggle("mobile-mode", mode === "mobile");
  document.body.classList.toggle("desktop-mode", mode === "desktop");
  
  document.querySelectorAll(".view-mode-button").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
  
  if (remember) {
    localStorage.setItem("reservation-view-mode", mode);
  }
  
  // 모드 변경 시 달력과 타임라인 재렌더링
  if (roomLayout) {
    renderCalendar();
    renderTimelineMatrix();
  }
}

// 3. 파일 로드 및 데이터 페치
async function loadRoomLayout() {
  try {
    const res = await fetch("./room_layout_data.json");
    roomLayout = await res.json();
    console.log("도면 좌표 데이터 로드 완료:", roomLayout);
  } catch (error) {
    console.error("도면 데이터를 로드하는 중 에러가 발생했습니다:", error);
    showToast("도면 정보를 불러올 수 없습니다.");
  }
}

// Supabase 예약 데이터 페치 (현재 달 및 인접 기간 데이터 조회)
async function refreshData(options = {}) {
  if (!supabaseClient) return;
  
  const refreshBtn = document.getElementById("refresh-btn");
  const silent = options.silent === true;
  if (refreshBtn && !silent) refreshBtn.classList.add("spinning");
  
  try {
    // 현재 보고 있는 달의 1일과 마지막 날 계산
    const firstDay = new Date(currentYear, currentMonth, 1);
    const lastDay = new Date(currentYear, currentMonth + 1, 0);
    
    // 달력 앞뒤 버퍼 추가하여 넉넉하게 페치 (이전달 말일 ~ 다음달 초)
    const startDateStr = formatDate(new Date(firstDay.getTime() - 7 * 24 * 60 * 60 * 1000));
    const endDateStr = formatDate(new Date(lastDay.getTime() + 7 * 24 * 60 * 60 * 1000));
    
    const { data, error } = await supabaseClient
      .from("room_reservations")
      .select("*")
      .gte("date", startDateStr)
      .lte("date", endDateStr);
      
    if (error) throw error;
    
    reservations = data || [];
    console.log("예약 데이터 페치 완료:", reservations.length, "건");
  } catch (error) {
    console.error("예약 데이터 페치 에러:", error);
    if (!silent) showToast("예약 현황을 불러오지 못했습니다.");
  } finally {
    if (refreshBtn && !silent) {
      setTimeout(() => refreshBtn.classList.remove("spinning"), 500);
    }
  }
}

// 4. 로그인 및 세션 관리
function loadUserSession() {
  const localSession = localStorage.getItem("kakao_user");
  if (localSession) {
    currentUser = JSON.parse(localSession);
    updateAuthWidget(true);
    return;
  }
  
  // 쿠키 확인 (localStorage 유실 대비)
  const cookieSession = getCookie("kakao_user_session");
  if (cookieSession) {
    try {
      currentUser = JSON.parse(decodeURIComponent(cookieSession));
      localStorage.setItem("kakao_user", JSON.stringify(currentUser));
      updateAuthWidget(true);
    } catch (e) {
      console.error("쿠키 파싱 에러:", e);
    }
  } else {
    updateAuthWidget(false);
  }
}

function saveUserSession(user) {
  currentUser = user;
  localStorage.setItem("kakao_user", JSON.stringify(user));
  
  // 10년 만료일 설정한 쿠키 생성
  const encodedUser = encodeURIComponent(JSON.stringify(user));
  setCookie("kakao_user_session", encodedUser, 3650); 
  
  updateAuthWidget(true);
  showToast(`${user.nickname}님, 반갑습니다!`);
  
  // 로그인 성공 후 예약 정보 리로드 및 UI 갱신
  renderAll();
}

function clearUserSession() {
  currentUser = null;
  localStorage.removeItem("kakao_user");
  deleteCookie("kakao_user_session");
  updateAuthWidget(false);
  showToast("로그아웃 되었습니다.");
  
  // UI 갱신
  renderAll();
}

function updateAuthWidget(isLoggedIn) {
  const loginBtn = document.getElementById("btn-login");
  const profileDiv = document.getElementById("user-profile");
  const avatarImg = document.getElementById("user-avatar");
  const nameSpan = document.getElementById("user-name");
  
  if (isLoggedIn && currentUser) {
    loginBtn.classList.add("hidden");
    profileDiv.classList.remove("hidden");
    
    // 프로필 이미지 (모의 로그인 시 기본 아바타 처리)
    avatarImg.src = currentUser.profile_image || "https://t1.kakaocdn.net/kakaocorp/kakaoland/usr/profile_default_2.png";
    nameSpan.textContent = currentUser.nickname;
  } else {
    loginBtn.classList.remove("hidden");
    profileDiv.classList.add("hidden");
  }
}

// 카카오 실 로그인 작동 흐름
function handleRealKakaoLogin() {
  if (!window.Kakao) return;
  
  try {
    // 초기화가 안 되었을 경우 초기화 실행
    if (!window.Kakao.isInitialized()) {
      window.Kakao.init(KAKAO_APP_KEY);
    }
    
    window.Kakao.Auth.login({
      success: function(authObj) {
        window.Kakao.API.request({
          url: '/v2/user/me',
          success: function(res) {
            try {
              const kakaoAccount = res.kakao_account || {};
              const profile = kakaoAccount.profile || {};
              const user = {
                id: `kakao_${res.id}`,
                nickname: profile.nickname || "카카오 사용자",
                profile_image: profile.profile_image_url || null
              };
              saveUserSession(user);
            } catch (e) {
              console.error("Kakao profile parse error:", e);
              showToast("사용자 정보 분석 실패: " + e.message);
            }
          },
          fail: function(err) {
            console.error("Kakao 프로필 페치 에러:", err);
            showToast("카카오 사용자 정보를 가져오지 못했습니다.");
          }
        });
      },
      fail: function(err) {
        console.error("Kakao Auth 에러:", err);
        const errMsg = err ? (err.error_description || err.error || JSON.stringify(err)) : "알 수 없는 오류";
        showToast("카카오 로그인 실패: " + errMsg);
      }
    });
  } catch (e) {
    console.error("Kakao login runtime error:", e);
    showToast("카카오 로그인 실행 오류: " + e.message);
    openMockLoginModal("런타임 에러 - " + e.message);
  }
}

// 5. 달력 렌더링 엔진 (일요일 시작)
function renderCalendar() {
  const daysGrid = document.getElementById("calendar-days-grid");
  const monthTitle = document.getElementById("current-month-year");
  
  if (!daysGrid || !roomLayout) return;
  
  daysGrid.innerHTML = "";
  monthTitle.textContent = `${currentYear}년 ${currentMonth + 1}월`;
  
  // 1일의 요일 및 해당 월의 마지막 날 구하기
  const firstDayIndex = new Date(currentYear, currentMonth, 1).getDay(); // 0(일요일) ~ 6(토요일)
  const lastDate = new Date(currentYear, currentMonth + 1, 0).getDate();
  
  // 이전달의 마지막 날 구하기 (이전달 채우기용)
  const prevLastDate = new Date(currentYear, currentMonth, 0).getDate();
  
  // 다음달 며칠까지 채워야 하는지 구하기 (6줄 그리드 기준 총 42칸 채우기)
  const totalSlots = 42; 
  
  for (let i = 0; i < totalSlots; i++) {
    const dayDiv = document.createElement("div");
    dayDiv.classList.add("calendar-day");
    
    let dayNumber = 0;
    let dateStr = "";
    let isCurrentMonth = true;
    
    if (i < firstDayIndex) {
      // 이전 달 영역
      dayNumber = prevLastDate - firstDayIndex + i + 1;
      dayDiv.classList.add("prev-month");
      isCurrentMonth = false;
      
      const prevMonthObj = getRelativeMonth(-1);
      dateStr = `${prevMonthObj.year}-${String(prevMonthObj.month + 1).padStart(2, "0")}-${String(dayNumber).padStart(2, "0")}`;
    } else if (i >= firstDayIndex + lastDate) {
      // 다음 달 영역
      dayNumber = i - (firstDayIndex + lastDate) + 1;
      dayDiv.classList.add("next-month");
      isCurrentMonth = false;
      
      const nextMonthObj = getRelativeMonth(1);
      dateStr = `${nextMonthObj.year}-${String(nextMonthObj.month + 1).padStart(2, "0")}-${String(dayNumber).padStart(2, "0")}`;
    } else {
      // 현재 달 영역
      dayNumber = i - firstDayIndex + 1;
      dateStr = `${currentYear}-${String(currentMonth + 1).padStart(2, "0")}-${String(dayNumber).padStart(2, "0")}`;
      
      if (dateStr === selectedDateStr) {
        dayDiv.classList.add("active-day");
      }
    }
    
    const datePolicy = checkDateReservationAllowed(dateStr);
    if (datePolicy.allowed) {
      dayDiv.classList.add("reservable-day");
    }
    
    // 일 수 라벨 추가
    const numSpan = document.createElement("span");
    numSpan.classList.add("calendar-day-number");
    numSpan.textContent = dayNumber;
    dayDiv.appendChild(numSpan);
    
    // 날짜별 예약 목록 매핑
    const dayReservations = reservations.filter(res => res.date === dateStr);
    
    // 정렬 (시작 시간 오름차순)
    dayReservations.sort((a, b) => a.start_time.localeCompare(b.start_time));
    
    const resContainer = document.createElement("div");
    resContainer.classList.add("calendar-day-reservations");
    
    dayReservations.forEach(res => {
      const pill = document.createElement("div");
      pill.classList.add("calendar-res-pill");
      applyReservationOwnerColor(pill, res);
      
      // 모바일 모드와 데스크톱 모드에 따른 표시 데이터 구분
      if (currentViewMode === "desktop") {
        pill.textContent = `[${res.start_time}] ${res.room_name.split("(")[0]} (${res.reserved_by})`;
      } else {
        // 모바일은 도트 색상 표시이므로 textContent는 보이지 않지만, hover 시 툴팁 등으로 활용 가능
        pill.textContent = "•"; 
      }
      
      // 예약 상세조회 클릭 바인딩
      pill.addEventListener("click", (e) => {
        e.stopPropagation(); // 셀 클릭 전파 방지
        showReservationDetail(res);
      });
      
      resContainer.appendChild(pill);
    });
    
    dayDiv.appendChild(resContainer);
    
    // 날짜 클릭 이벤트 바인딩
    dayDiv.addEventListener("click", () => {
      selectDate(dateStr, dayDiv);
    });
    
    daysGrid.appendChild(dayDiv);
  }
}

// 특정 달 기준 이전(-1) 또는 다음(1) 달 정보 구하기
function getRelativeMonth(offset) {
  const date = new Date(currentYear, currentMonth + offset, 1);
  return {
    year: date.getFullYear(),
    month: date.getMonth()
  };
}

// 6. SVG 도면 그리며 예약 상태 채우기
function renderRoomLayout() {
  const svg = document.getElementById("room-layout-svg");
  const modal = document.getElementById("reservation-modal");
  
  if (!svg || !roomLayout) return;
  
  // 기존 동적 콘텐츠 클리어 (정적 엘리먼트 외 청소)
  svg.innerHTML = "";
  
  // 예약 모달 닫기
  modal.classList.add("hidden");
  
  // 날짜 기준 예약 가용 슬롯 계산을 위해 현재 선택 날짜의 예약 리스트 확보
  const dateReservations = reservations.filter(res => res.date === selectedDateStr);
  
  // 1. 빌딩 경계(Wrapper Bounds) 그리기
  const wrappers = roomLayout.shapes.filter(s => s.role === "building_bounds");
  wrappers.forEach(w => {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", w.x);
    rect.setAttribute("y", w.y);
    rect.setAttribute("width", w.width);
    rect.setAttribute("height", w.height);
    rect.setAttribute("class", "building-border");
    rect.setAttribute("rx", "12");
    svg.appendChild(rect);
  });
  
  // 2. 텍스트 헤더 그리기
  const headers = roomLayout.shapes.filter(s => s.role === "header");
  headers.forEach(h => {
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", h.x + 10);
    text.setAttribute("y", h.y + 24);
    text.setAttribute("class", "building-label");
    text.textContent = h.text;
    svg.appendChild(text);
  });
  
  // 3. 실제 방(Rooms / Utilities) 그리기
  const rooms = roomLayout.shapes.filter(s => s.role === "room");
  rooms.forEach(r => {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("id", `svg-room-${r.id}`);
    rect.setAttribute("x", r.x);
    rect.setAttribute("y", r.y);
    rect.setAttribute("width", r.width);
    rect.setAttribute("height", r.height);
    rect.setAttribute("rx", "6");
    
    // 예약 현황 계산
    let stateClass = "status-available";
    if (!r.is_reservable) {
      stateClass = "status-utility";
    } else {
      const roomRes = dateReservations.filter(res => res.room_id === r.id);
      
      if (roomRes.length > 0) {
        // 예약 슬롯 수 계산 (1시간 단위 슬롯)
        const bookedSlotsCount = TIME_SLOTS.filter((_, idx) => {
          return roomRes.some(res => reservationOverlapsSlot(res, idx));
        }).length;
        
        if (bookedSlotsCount >= TIME_SLOTS.length) {
          stateClass = "status-full";
        } else if (bookedSlotsCount > 0) {
          stateClass = "status-partial";
        }
      }
    }
    
    rect.setAttribute("class", `room-shape ${stateClass}`);
    svg.appendChild(rect);
    
    // 클릭 이벤트 추가 (예약 가능 구역인 경우에만 작동)
    if (r.is_reservable) {
      rect.addEventListener("click", (e) => {
        e.stopPropagation();
        openReservationModal(r);
      });
    }
    
    // 텍스트 라벨 추가
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", r.x + r.width / 2);
    text.setAttribute("y", r.y + r.height / 2);
    
    // 긴 텍스트 줄바꿈/잘림 가공 (교육관 1 (구 대학부실...) -> 교육관 1)
    let displayName = r.text;
    if (displayName.includes("(")) {
      displayName = displayName.split("(")[0].trim();
    }
    
    const textClasses = ["room-text"];
    if (!r.is_reservable) textClasses.push("room-text-utility");
    if (PROMINENT_ROOM_LABELS.includes(displayName)) textClasses.push("room-text-prominent");
    text.setAttribute("class", textClasses.join(" "));
    text.textContent = displayName;
    
    svg.appendChild(text);
  });
}

// 7. 예약 시간 선택용 모달 다이얼로그 관리
let selectedModalSlots = [];
let selectedModalRoom = null;
let isDraggingSlots = false;
let lastTouchedSlotTime = "";
let touchDragAnchorSlotIdx = -1;
const TOUCH_SLOT_Y_TOLERANCE = 56;
const ADMIN_NICKNAMES = ["최종범"];
const PROMINENT_ROOM_LABELS = ["교육관 1", "본관", "교육관 2", "교육관 3", "소그룹 C", "소그룹 D"];
const WEEKLY_BOOKING_OPEN_HOUR = 10;

function isCurrentUserAdmin() {
  if (!currentUser) return false;
  return ADMIN_NICKNAMES.includes((currentUser.nickname || "").trim());
}

function openReservationModal(room) {
  if (!checkLogin()) return;
  
  const datePolicy = checkDateReservationAllowed(selectedDateStr);
  if (!datePolicy.allowed) {
    showToast(datePolicy.message || "지난 날짜는 예약할 수 없습니다.");
    return;
  }
  
  selectedModalRoom = room;
  selectedModalSlots = [];
  
  const modal = document.getElementById("reservation-modal");
  const modalRoomName = document.getElementById("modal-room-name");
  const modalDate = document.getElementById("modal-date");
  const modalSlotsGrid = document.getElementById("modal-slots-grid");
  const titleInput = document.getElementById("modal-title-input");
  
  // 타이틀 초기화
  titleInput.value = "";
  
  // 메타 정보 표시
  modalRoomName.textContent = room.text;
  modalDate.textContent = selectedDateStr;
  
  // 현재 날짜/방의 예약 상황 추출
  const roomRes = reservations.filter(res => res.date === selectedDateStr && res.room_id === room.id);
  
  // 1시간 단위 슬롯 생성
  modalSlotsGrid.innerHTML = "";
  
  TIME_SLOTS.forEach(time => {
    const chip = document.createElement("div");
    chip.classList.add("time-slot-chip");
    chip.textContent = "";
    chip.title = time;
    chip.dataset.time = time;
    
    // 이미 예약되었는지 여부 확인
    const isBooked = roomRes.some(res => {
      const currentIndex = TIME_SLOTS.indexOf(time);
      return reservationOverlapsSlot(res, currentIndex);
    });
    
    if (isBooked) {
      chip.classList.add("booked");
      
      // 예약 디테일 찾기
      const activeRes = roomRes.find(res => {
        const currentIndex = TIME_SLOTS.indexOf(time);
        return reservationOverlapsSlot(res, currentIndex);
      });
      
      if (activeRes) {
        chip.addEventListener("mouseenter", () => {
          const tooltip = document.getElementById("modal-timeline-tooltip");
          if (tooltip) {
            tooltip.textContent = `${activeRes.reserved_by}: ${activeRes.title}`;
            tooltip.classList.remove("hidden");
            const leftPercent = (TIME_SLOTS.indexOf(time) + 0.5) / TIME_SLOTS.length * 100;
            tooltip.style.left = `${leftPercent}%`;
          }
        });
        chip.addEventListener("mouseleave", () => {
          updateModalTimelineTooltip();
        });
      }
    } else {
      // 드래그/클릭 바인딩
      chip.addEventListener("mousedown", (e) => {
        isDraggingSlots = true;
        toggleSlotSelection(time, chip);
        e.preventDefault();
      });
      
      chip.addEventListener("mouseenter", (e) => {
        if (isDraggingSlots) {
          if (e.buttons !== 1) { // 마우스 클릭이 풀린 상태면 드래그 종료
            isDraggingSlots = false;
            return;
          }
          toggleSlotSelection(time, chip);
        }
      });
      
      chip.addEventListener("touchstart", (e) => {
        isDraggingSlots = true;
        lastTouchedSlotTime = time;
        touchDragAnchorSlotIdx = TIME_SLOTS.indexOf(time);
        setModalSlotRangeSelection(touchDragAnchorSlotIdx, touchDragAnchorSlotIdx);
        e.preventDefault();
      }, { passive: false });
      
      chip.addEventListener("touchmove", (e) => {
        if (!isDraggingSlots) return;
        e.preventDefault();
        
        const touch = e.touches[0];
        if (!touch) return;
        
        const targetChip = getSlotChipFromTouchPoint(touch.clientX, touch.clientY);
        if (!targetChip) return;
        
        const targetTime = targetChip.dataset.time;
        if (targetTime && targetTime !== lastTouchedSlotTime) {
          lastTouchedSlotTime = targetTime;
          setModalSlotRangeSelection(touchDragAnchorSlotIdx, TIME_SLOTS.indexOf(targetTime));
        }
      }, { passive: false });
    }
    
    modalSlotsGrid.appendChild(chip);
  });
  
  // 모달 띄우기
  updateModalTimelineTooltip();
  modal.classList.remove("hidden");
}

function getSlotChipFromTouchPoint(clientX, clientY) {
  const slotsGrid = document.getElementById("modal-slots-grid");
  if (!slotsGrid) return null;
  
  const rect = slotsGrid.getBoundingClientRect();
  const isWithinYRange = clientY >= rect.top - TOUCH_SLOT_Y_TOLERANCE && clientY <= rect.bottom + TOUCH_SLOT_Y_TOLERANCE;
  if (!isWithinYRange) return null;
  
  const clampedX = Math.min(Math.max(clientX, rect.left), rect.right - 1);
  const slotWidth = rect.width / TIME_SLOTS.length;
  const slotIdx = Math.min(TIME_SLOTS.length - 1, Math.max(0, Math.floor((clampedX - rect.left) / slotWidth)));
  return slotsGrid.querySelector(`.time-slot-chip[data-time="${TIME_SLOTS[slotIdx]}"]`);
}

function setModalSlotRangeSelection(anchorIdx, currentIdx) {
  if (anchorIdx < 0 || currentIdx < 0) return;
  
  const minIdx = Math.min(anchorIdx, currentIdx);
  const maxIdx = Math.max(anchorIdx, currentIdx);
  const chips = Array.from(document.querySelectorAll("#modal-slots-grid .time-slot-chip"));
  const rangeChips = chips.filter(chip => {
    const idx = TIME_SLOTS.indexOf(chip.dataset.time);
    return idx >= minIdx && idx <= maxIdx;
  });
  
  if (rangeChips.some(chip => chip.classList.contains("booked"))) {
    showToast("이미 예약된 시간대가 포함되어 있습니다.");
    return;
  }
  
  chips.forEach(chip => chip.classList.remove("selected"));
  selectedModalSlots = [];
  
  rangeChips.forEach(chip => {
    chip.classList.add("selected");
    selectedModalSlots.push(chip.dataset.time);
  });
  
  selectedModalSlots.sort((a, b) => TIME_SLOTS.indexOf(a) - TIME_SLOTS.indexOf(b));
  updateModalTimelineTooltip();
}

function toggleSlotSelection(time, chipElement) {
  if (chipElement.classList.contains("booked")) return;
  
  const index = selectedModalSlots.indexOf(time);
  if (index === -1) {
    if (selectedModalSlots.length === 0) {
      selectedModalSlots.push(time);
      chipElement.classList.add("selected");
    } else {
      // 기존 선택된 인덱스 범위 확인
      const indices = selectedModalSlots.map(t => TIME_SLOTS.indexOf(t));
      const minIdx = Math.min(...indices);
      const maxIdx = Math.max(...indices);
      const newIdx = TIME_SLOTS.indexOf(time);
      
      // 인접한 칸인지 확인 (연속성 유지)
      if (newIdx === minIdx - 1 || newIdx === maxIdx + 1) {
        selectedModalSlots.push(time);
        chipElement.classList.add("selected");
      } else {
        // 인접하지 않은 경우 기존 선택 해제하고 새로운 단일 선택으로 교체
        document.querySelectorAll("#modal-slots-grid .time-slot-chip").forEach(chip => {
          chip.classList.remove("selected");
        });
        selectedModalSlots = [time];
        chipElement.classList.add("selected");
      }
    }
  } else {
    // 이미 선택된 셀을 클릭해서 취소하려는 경우
    const tempSlots = selectedModalSlots.filter(t => t !== time);
    
    // 제거 후에도 여전히 연속적인지 확인
    let remainsContiguous = true;
    if (tempSlots.length > 1) {
      const sortedIndices = tempSlots.map(t => TIME_SLOTS.indexOf(t)).sort((a, b) => a - b);
      for (let i = 0; i < sortedIndices.length - 1; i++) {
        if (sortedIndices[i+1] - sortedIndices[i] !== 1) {
          remainsContiguous = false;
          break;
        }
      }
    }
    
    if (remainsContiguous) {
      selectedModalSlots = tempSlots;
      chipElement.classList.remove("selected");
    } else {
      // 연속성이 깨지는 경우 모든 선택 해제
      document.querySelectorAll("#modal-slots-grid .time-slot-chip").forEach(chip => {
        chip.classList.remove("selected");
      });
      selectedModalSlots = [];
    }
  }
  
  // 선택 슬롯들 정렬
  selectedModalSlots.sort((a, b) => TIME_SLOTS.indexOf(a) - TIME_SLOTS.indexOf(b));
  updateModalTimelineTooltip();
}

function closeReservationModal() {
  const modal = document.getElementById("reservation-modal");
  modal.classList.add("hidden");
  selectedModalRoom = null;
  selectedModalSlots = [];
  lastTouchedSlotTime = "";
  touchDragAnchorSlotIdx = -1;
  updateModalTimelineTooltip();
}

function updateModalTimelineTooltip() {
  const tooltip = document.getElementById("modal-timeline-tooltip");
  if (!tooltip) return;
  
  if (selectedModalSlots.length === 0) {
    tooltip.classList.add("hidden");
    return;
  }
  
  // 선택 슬롯들의 최소/최대 인덱스 찾기
  const indices = selectedModalSlots.map(t => TIME_SLOTS.indexOf(t));
  const minIdx = Math.min(...indices);
  const maxIdx = Math.max(...indices);
  
  const startTime = TIME_SLOTS[minIdx];
  const endTime = getSlotEndTime(maxIdx);
  
  tooltip.textContent = `${startTime} ~ ${endTime}`;
  tooltip.classList.remove("hidden");
  
  // 선택 영역 중앙에 말풍선 배치
  const centerSlot = (minIdx + maxIdx) / 2;
  const leftPercent = (centerSlot + 0.5) / TIME_SLOTS.length * 100;
  tooltip.style.left = `${leftPercent}%`;
}

// 8. 하단 타임라인 예약 매트릭스 렌더링
let isTimelineDragging = false;
let dragStartSlotIdx = -1;
let dragEndSlotIdx = -1;
let dragRoomId = "";
const TIMELINE_TOUCH_Y_TOLERANCE = 36;
const TIMELINE_LONG_PRESS_MS = 350;
const TIMELINE_TOUCH_CANCEL_DISTANCE = 24;
let timelineLongPressTimer = null;
let pendingTimelineTouch = null;
let isTimelineTouchSelectMode = false;

function renderTimelineMatrix() {
  const table = document.getElementById("timeline-matrix-table");
  if (!table || !roomLayout) return;
  
  table.innerHTML = "";
  
  // 1. 헤더 행 생성 (공간명 + 1시간 단위 슬롯 컬럼)
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  
  const thRoom = document.createElement("th");
  thRoom.textContent = "공간 목록";
  headerRow.appendChild(thRoom);
  
  TIME_SLOTS.forEach(time => {
    const thTime = document.createElement("th");
    thTime.textContent = time;
    headerRow.appendChild(thTime);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);
  
  // 2. 바디 행 생성 (각 예약 가능 방 리스트업)
  const tbody = document.createElement("tbody");
  const reservableRooms = roomLayout.shapes.filter(s => s.role === "room" && s.is_reservable);
  const dateReservations = reservations.filter(res => res.date === selectedDateStr);
  
  reservableRooms.forEach(room => {
    const row = document.createElement("tr");
    
    // 첫 컬럼: 방 이름
    const tdName = document.createElement("td");
    tdName.textContent = room.text.split("(")[0].trim();
    row.appendChild(tdName);
    
    // 예약 상태를 인덱스 배열로 생성 (true면 예약됨)
    const slotBookingMap = new Array(TIME_SLOTS.length).fill(null);
    const roomRes = dateReservations.filter(res => res.room_id === room.id);
    
    roomRes.forEach(res => {
      for (let idx = 0; idx < TIME_SLOTS.length; idx++) {
        if (reservationOverlapsSlot(res, idx)) {
          slotBookingMap[idx] = res;
        }
      }
    });
    
    // 가로 슬롯 렌더링
    for (let idx = 0; idx < TIME_SLOTS.length; idx++) {
      const tdCell = document.createElement("td");
      tdCell.classList.add("matrix-cell");
      tdCell.dataset.roomId = room.id;
      tdCell.dataset.slotIdx = idx;
      
      const reservation = slotBookingMap[idx];
      if (reservation) {
        tdCell.classList.add("booked");
        
        // 예약이 연속되는 경우 첫 번째 셀에 뱃지 바(span bar)를 오버레이 렌더링
        const prevReservation = idx > 0 ? slotBookingMap[idx - 1] : null;
        if (!prevReservation || prevReservation.id !== reservation.id) {
          // 연속된 예약 길이 계산
          let duration = 0;
          let tempIdx = idx;
          while (tempIdx < TIME_SLOTS.length && slotBookingMap[tempIdx] && slotBookingMap[tempIdx].id === reservation.id) {
            duration++;
            tempIdx++;
          }
          
          // 예약 표시 바 렌더링
          const bar = document.createElement("div");
          bar.classList.add("matrix-booking-bar");
          applyReservationOwnerColor(bar, reservation);
          
          bar.style.width = `calc(${duration * 100}% - 4px)`;
          bar.style.zIndex = "5";
          bar.textContent = `${reservation.reserved_by}: ${reservation.title}`;
          
          // 예약 상세 팝업 클릭 바인딩
          bar.addEventListener("click", (e) => {
            e.stopPropagation();
            showReservationDetail(reservation);
          });
          
          tdCell.appendChild(bar);
        }
      } else {
        // 드래그를 통한 시간 선택 예약 기능
        tdCell.addEventListener("mousedown", (e) => {
          beginTimelineDragSelection(room.id, idx, tdCell);
          e.preventDefault();
        });
        
        tdCell.addEventListener("mouseenter", (e) => {
          if (isTimelineDragging && dragRoomId === room.id) {
            if (e.buttons !== 1) { // 마우스 클릭이 풀린 상태면 드래그 종료 및 초기화
              isTimelineDragging = false;
              dragRoomId = "";
              dragStartSlotIdx = -1;
              dragEndSlotIdx = -1;
              renderTimelineMatrix();
              return;
            }
            dragEndSlotIdx = idx;
            // 범위 내 가시적 하이라이트 반영
            highlightTimelineDragSelection(room.id);
          }
        });
        
        tdCell.addEventListener("click", (e) => {
          if (!isTimelineTouchSelectMode || dragRoomId !== room.id) return;
          e.preventDefault();
          e.stopPropagation();
          updateTimelineTouchSelection(room.id, idx);
        });
        
        tdCell.addEventListener("touchstart", (e) => {
          scheduleTimelineLongPressSelection(e, room.id, idx, tdCell);
        }, { passive: true });
        
        tdCell.addEventListener("touchmove", (e) => {
          cancelTimelineLongPressIfMoved(e);
        }, { passive: false });
        
        tdCell.addEventListener("touchend", (e) => {
          if (isTimelineTouchSelectMode) {
            return;
          }
          clearTimelineLongPress();
        });
        
        tdCell.addEventListener("touchcancel", () => {
          clearTimelineLongPress();
        });
        
        tdCell.addEventListener("contextmenu", (e) => {
          if (isTimelineDragging || pendingTimelineTouch) {
            e.preventDefault();
          }
        });
      }
      
      row.appendChild(tdCell);
    }
    
    tbody.appendChild(row);
  });
  
  table.appendChild(tbody);
}

function scheduleTimelineLongPressSelection(e, roomId, slotIdx, sourceCell) {
  const point = getTimelineEventPoint(e);
  if (!point) return;
  
  clearTimelineLongPress();
  pendingTimelineTouch = {
    roomId,
    slotIdx,
    sourceCell,
    startX: point.clientX,
    startY: point.clientY
  };
  
  timelineLongPressTimer = setTimeout(() => {
    if (!pendingTimelineTouch) return;
    const started = beginTimelineTouchSelectionMode(roomId, slotIdx, sourceCell);
    if (started && window.navigator && window.navigator.vibrate) {
      window.navigator.vibrate(12);
    }
    pendingTimelineTouch = null;
  }, TIMELINE_LONG_PRESS_MS);
}

function clearTimelineLongPress() {
  clearTimeout(timelineLongPressTimer);
  timelineLongPressTimer = null;
  pendingTimelineTouch = null;
}

function getTimelineEventPoint(e) {
  if (e.touches && e.touches[0]) {
    return {
      clientX: e.touches[0].clientX,
      clientY: e.touches[0].clientY,
      pointerId: null
    };
  }
  
  if (typeof e.clientX === "number" && typeof e.clientY === "number") {
    return {
      clientX: e.clientX,
      clientY: e.clientY,
      pointerId: typeof e.pointerId === "number" ? e.pointerId : null
    };
  }
  
  return null;
}

function clearTimelineSelectionVisuals() {
  document.body.classList.remove("timeline-touch-selecting");
  removeTimelineTouchSelectActions();
  const existingBar = document.getElementById("matrix-dynamic-selecting-bar");
  if (existingBar) existingBar.remove();
  document.querySelectorAll(".matrix-cell.timeline-touch-active").forEach(cell => {
    cell.classList.remove("timeline-touch-active");
  });
}

function beginTimelineTouchSelectionMode(roomId, slotIdx, sourceCell = null) {
  const started = beginTimelineDragSelection(roomId, slotIdx, sourceCell);
  if (!started) return false;
  
  isTimelineTouchSelectMode = true;
  showTimelineTouchSelectActions();
  showToast("선택 모드: 시간칸을 눌러 범위를 조정한 뒤 완료를 누르세요.");
  return true;
}

function beginTimelineDragSelection(roomId, slotIdx, sourceCell = null) {
  if (!checkLogin()) return false;
  
  const datePolicy = checkDateReservationAllowed(selectedDateStr);
  if (!datePolicy.allowed) {
    showToast(datePolicy.message || "지난 날짜는 예약할 수 없습니다.");
    return false;
  }
  
  isTimelineDragging = true;
  dragRoomId = roomId;
  dragStartSlotIdx = slotIdx;
  dragEndSlotIdx = slotIdx;
  document.body.classList.add("timeline-touch-selecting");
  highlightTimelineDragSelection(roomId, sourceCell);
  return true;
}

function cancelTimelineLongPressIfMoved(e) {
  const point = getTimelineEventPoint(e);
  if (!point) return;
  
  if (!pendingTimelineTouch) return;
  const deltaX = point.clientX - pendingTimelineTouch.startX;
  const deltaY = point.clientY - pendingTimelineTouch.startY;
  const movedDistance = Math.hypot(deltaX, deltaY);
  if (movedDistance > TIMELINE_TOUCH_CANCEL_DISTANCE) {
    clearTimelineLongPress();
  }
}

function finishTimelinePointerSelection(options = {}) {
  clearTimelineLongPress();
  
  if (!isTimelineDragging) return;
  
  isTimelineDragging = false;
  if (options.cancelled) {
    dragRoomId = "";
    dragStartSlotIdx = -1;
    dragEndSlotIdx = -1;
    clearTimelineSelectionVisuals();
    return;
  }
  
  handleTimelineDragEnd();
}

function updateTimelineTouchSelection(roomId, slotIdx) {
  if (!isTimelineTouchSelectMode || dragRoomId !== roomId) return;
  dragEndSlotIdx = slotIdx;
  highlightTimelineDragSelection(roomId);
}

function completeTimelineTouchSelection() {
  if (!isTimelineTouchSelectMode) return;
  isTimelineTouchSelectMode = false;
  isTimelineDragging = false;
  handleTimelineDragEnd();
}

function cancelTimelineTouchSelection() {
  isTimelineTouchSelectMode = false;
  isTimelineDragging = false;
  dragRoomId = "";
  dragStartSlotIdx = -1;
  dragEndSlotIdx = -1;
  clearTimelineSelectionVisuals();
}

function showTimelineTouchSelectActions() {
  removeTimelineTouchSelectActions();
  
  const actions = document.createElement("div");
  actions.id = "timeline-touch-select-actions";
  actions.className = "timeline-touch-select-actions";
  
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "timeline-touch-action secondary";
  cancelBtn.textContent = "취소";
  cancelBtn.addEventListener("click", cancelTimelineTouchSelection);
  
  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.className = "timeline-touch-action primary";
  doneBtn.textContent = "완료";
  doneBtn.addEventListener("click", completeTimelineTouchSelection);
  
  actions.appendChild(cancelBtn);
  actions.appendChild(doneBtn);
  document.body.appendChild(actions);
}

function removeTimelineTouchSelectActions() {
  const actions = document.getElementById("timeline-touch-select-actions");
  if (actions) actions.remove();
}

function getTimelineCellFromTouchPoint(clientX, clientY) {
  if (!dragRoomId) {
    const target = document.elementFromPoint(clientX, clientY);
    return target ? target.closest(".matrix-cell") : null;
  }
  
  const rowCells = Array.from(document.querySelectorAll(`.matrix-cell[data-room-id="${dragRoomId}"]`));
  if (rowCells.length === 0) return null;
  
  const firstRect = rowCells[0].getBoundingClientRect();
  const lastRect = rowCells[rowCells.length - 1].getBoundingClientRect();
  const isWithinYRange = clientY >= firstRect.top - TIMELINE_TOUCH_Y_TOLERANCE && clientY <= firstRect.bottom + TIMELINE_TOUCH_Y_TOLERANCE;
  if (!isWithinYRange) return null;
  
  const left = firstRect.left;
  const right = lastRect.right;
  const clampedX = Math.min(Math.max(clientX, left), right - 1);
  const slotWidth = (right - left) / TIME_SLOTS.length;
  const slotIdx = Math.min(TIME_SLOTS.length - 1, Math.max(0, Math.floor((clampedX - left) / slotWidth)));
  return rowCells[slotIdx];
}

// 전역 마우스 업 감지하여 타임라인 드래그 완료 후 예약 폼 팝업 연동
function handleTimelineDragEnd() {
  if (dragRoomId === "") return;
  
  // 예약 창을 띄울 방 찾기
  const room = roomLayout.shapes.find(s => s.id === dragRoomId);
  if (room && dragStartSlotIdx !== -1 && dragEndSlotIdx !== -1) {
    // 드래그 순서 보정
    const minIdx = Math.min(dragStartSlotIdx, dragEndSlotIdx);
    const maxIdx = Math.max(dragStartSlotIdx, dragEndSlotIdx);
    
    // 이미 예약된 슬롯이 중간에 끼어있는지 확인
    const dateReservations = reservations.filter(res => res.date === selectedDateStr && res.room_id === dragRoomId);
    let hasConflict = false;
    
    const dragSlots = [];
    for (let idx = minIdx; idx <= maxIdx; idx++) {
      const time = TIME_SLOTS[idx];
      const isBooked = dateReservations.some(res => {
        return reservationOverlapsSlot(res, idx);
      });
      
      if (isBooked) {
        hasConflict = true;
        break;
      }
      dragSlots.push(time);
    }
    
    if (hasConflict) {
      showToast("이미 예약된 시간대가 포함되어 있습니다.");
      renderTimelineMatrix(); // 하이라이트 초기화용 재렌더링
    } else {
      // 해당 방 기준으로 예약 모달 트리거 및 슬롯 설정
      openReservationModal(room);
      
      // 모달의 칩 선택 상태 동기화
      selectedModalSlots = dragSlots;
      document.querySelectorAll(".time-slot-chip").forEach(chip => {
        const time = chip.dataset.time;
        if (dragSlots.includes(time)) {
          chip.classList.add("selected");
        } else {
          chip.classList.remove("selected");
        }
      });
      updateModalTimelineTooltip();
    }
  }
  
  dragRoomId = "";
  dragStartSlotIdx = -1;
  dragEndSlotIdx = -1;
  clearTimelineSelectionVisuals();
}

// 타임라인 내 드래그 범위 하이라이트 계산
function highlightTimelineDragSelection(roomId, preferredStartCell = null) {
  // 기존 하이라이트 바 제거
  const existingBar = document.getElementById("matrix-dynamic-selecting-bar");
  if (existingBar) {
    existingBar.remove();
  }
  document.querySelectorAll(".matrix-cell.timeline-touch-active").forEach(cell => {
    cell.classList.remove("timeline-touch-active");
  });
  
  if (dragStartSlotIdx === -1 || dragEndSlotIdx === -1 || roomId === "") return;
  
  const minIdx = Math.min(dragStartSlotIdx, dragEndSlotIdx);
  const maxIdx = Math.max(dragStartSlotIdx, dragEndSlotIdx);
  
  // 이미 예약된 슬롯이 중간에 끼어있는지 확인
  const dateReservations = reservations.filter(res => res.date === selectedDateStr && res.room_id === roomId);
  let hasConflict = false;
  
  for (let idx = minIdx; idx <= maxIdx; idx++) {
    const isBooked = dateReservations.some(res => {
      return reservationOverlapsSlot(res, idx);
    });
    if (isBooked) {
      hasConflict = true;
      break;
    }
  }
  
  // 첫 번째 셀 위치에 바를 오버레이로 그려줌
  const rowCells = Array.from(document.querySelectorAll(`.matrix-cell[data-room-id="${roomId}"]`));
  const startCell = preferredStartCell || rowCells[minIdx] || document.querySelector(`.matrix-cell[data-room-id="${roomId}"][data-slot-idx="${minIdx}"]`);
  if (startCell) {
    startCell.classList.add("timeline-touch-active");
    const bar = document.createElement("div");
    bar.id = "matrix-dynamic-selecting-bar";
    bar.classList.add("matrix-selecting-bar");
    
    // 예약 여부에 따라 스타일 분기
    if (hasConflict) {
      bar.classList.add("selecting-bar-red");
      bar.textContent = "선택 불가 (예약 있음)";
    } else {
      const room = roomLayout.shapes.find(s => s.id === roomId);
      const roomText = room ? room.text : "";
      if (roomText.includes("교육관")) {
        bar.classList.add("selecting-bar-blue");
      } else if (roomText.includes("소그룹")) {
        bar.classList.add("selecting-bar-orange");
      } else {
        bar.classList.add("selecting-bar-emerald");
      }
      bar.textContent = "선택 중...";
    }
    
    // 시간 안내 말풍선 추가
    const startTime = TIME_SLOTS[minIdx];
    const endTime = getSlotEndTime(maxIdx);
    
    const tooltip = document.createElement("div");
    tooltip.classList.add("matrix-selecting-tooltip");
    tooltip.textContent = hasConflict ? "선택 불가" : `${startTime} ~ ${endTime}`;
    bar.appendChild(tooltip);
    
    const duration = maxIdx - minIdx + 1;
    bar.style.width = `calc(${duration * 100}% - 4px)`;
    startCell.appendChild(bar);
  }
}

// 9. 예약 삽입 (Supabase INSERT)
async function submitReservation() {
  if (!checkLogin()) return;
  if (!selectedModalRoom) return;
  
  const datePolicy = checkDateReservationAllowed(selectedDateStr);
  if (!datePolicy.allowed) {
    showToast(datePolicy.message || "지난 날짜는 예약할 수 없습니다.");
    return;
  }
  
  const titleInput = document.getElementById("modal-title-input");
  const title = titleInput.value.trim();
  
  if (selectedModalSlots.length === 0) {
    showToast("예약할 시간 슬롯을 드래그 또는 클릭하여 선택하십시오.");
    return;
  }
  
  if (!title) {
    showToast("사용 목적을 입력하십시오.");
    titleInput.focus();
    return;
  }
  
  // 시작 시간과 종료 시간 유추 (연속된 시간의 최솟값 ~ 최댓값 + 1시간)
  selectedModalSlots.sort((a, b) => TIME_SLOTS.indexOf(a) - TIME_SLOTS.indexOf(b));
  
  // 연속성 검증
  const indices = selectedModalSlots.map(t => TIME_SLOTS.indexOf(t));
  for (let i = 0; i < indices.length - 1; i++) {
    if (indices[i + 1] - indices[i] !== 1) {
      showToast("예약은 중단 없이 연속된 시간대만 선택 가능합니다.");
      return;
    }
  }
  
  const startTime = selectedModalSlots[0];
  const lastSelectedIdx = TIME_SLOTS.indexOf(selectedModalSlots[selectedModalSlots.length - 1]);
  
  // 종료 시간은 마지막 선택 슬롯의 1시간 뒤
  const endTime = getSlotEndTime(lastSelectedIdx);
  
  const payload = {
    room_id: selectedModalRoom.id,
    room_name: selectedModalRoom.text,
    date: selectedDateStr,
    start_time: startTime,
    end_time: endTime,
    title: title,
    reserved_by: currentUser.nickname,
    user_id: currentUser.id
  };
  
  try {
    const { data: latestRoomReservations, error: conflictFetchError } = await supabaseClient
      .from("room_reservations")
      .select("*")
      .eq("room_id", selectedModalRoom.id)
      .eq("date", selectedDateStr);
      
    if (conflictFetchError) throw conflictFetchError;
    
    const conflictingReservation = (latestRoomReservations || []).find(res => {
      return reservationsOverlap(startTime, endTime, res.start_time, res.end_time);
    });
    
    if (conflictingReservation) {
      showToast("방금 다른 사용자가 해당 시간대를 예약했습니다. 최신 현황으로 갱신합니다.");
      closeReservationModal();
      await refreshData();
      renderAll();
      return;
    }
    
    const { data, error } = await supabaseClient
      .from("room_reservations")
      .insert([payload]);
      
    if (error) throw error;
    
    showToast("예약이 성공적으로 등록되었습니다.");
    closeReservationModal();
    
    // 데이터 새로고침 및 UI 갱신
    await refreshData();
    renderAll();
  } catch (error) {
    console.error("예약 생성 에러:", error);
    const errorMessage = error && error.message ? error.message : "";
    if (errorMessage.includes("이미 예약된 시간대")) {
      showToast("방금 다른 사용자가 해당 시간대를 예약했습니다. 최신 현황으로 갱신합니다.");
      await refreshData();
      renderAll();
    } else {
      showToast("예약을 처리하는 동안 오류가 발생했습니다.");
    }
  }
}

// 10. 예약 상세 확인 및 삭제 (Supabase DELETE)
let activeReservationForDetail = null;

function showReservationDetail(res) {
  activeReservationForDetail = res;
  
  const modal = document.getElementById("reservation-detail-modal");
  const roomName = document.getElementById("detail-room-name");
  const dateTime = document.getElementById("detail-date-time");
  const title = document.getElementById("detail-title");
  const user = document.getElementById("detail-user");
  const delBtn = document.getElementById("detail-delete-btn");
  
  // 커스텀 확인 창 리셋
  document.getElementById("detail-view-container").classList.remove("hidden");
  document.getElementById("detail-confirm-container").classList.add("hidden");
  
  roomName.textContent = res.room_name;
  dateTime.textContent = `${res.date}  |  ${res.start_time} ~ ${res.end_time}`;
  title.textContent = res.title;
  user.textContent = res.reserved_by;
  
  // 본인 또는 관리자의 예약이며 오늘 또는 미래 날짜인 경우에만 취소 활성화 (지난 예약은 변경 불가)
  const todayStr = formatDate(new Date());
  const canDeleteReservation = currentUser && (res.user_id === currentUser.id || isCurrentUserAdmin()) && res.date >= todayStr;
  if (canDeleteReservation) {
    delBtn.classList.remove("hidden");
  } else {
    delBtn.classList.add("hidden");
  }
  
  modal.classList.remove("hidden");
}

async function cancelReservationSilent() {
  if (!activeReservationForDetail || !checkLogin()) return;
  
  if (activeReservationForDetail.user_id !== currentUser.id && !isCurrentUserAdmin()) {
    showToast("본인의 예약만 취소할 수 있습니다. 관리자는 모든 예약을 취소할 수 있습니다.");
    return;
  }
  
  const todayStr = formatDate(new Date());
  if (activeReservationForDetail.date < todayStr) {
    showToast("지난 예약은 취소할 수 없습니다.");
    return;
  }
  
  try {
    const { error } = await supabaseClient
      .from("room_reservations")
      .delete()
      .eq("id", activeReservationForDetail.id);
      
    if (error) throw error;
    
    showToast("예약이 성공적으로 취소되었습니다.");
    document.getElementById("reservation-detail-modal").classList.add("hidden");
    activeReservationForDetail = null;
    
    // 리로드 및 리렌더
    await refreshData();
    renderAll();
  } catch (error) {
    console.error("예약 삭제 에러:", error);
    showToast("예약 취소 처리에 실패했습니다.");
  }
}

// 11. 유틸리티 및 보조 UI 함수
function selectDate(dateStr, triggerElement = null) {
  const datePolicy = checkDateReservationAllowed(dateStr);
  if (datePolicy.reason === "locked") {
    showFloatingTooltip(triggerElement || document.body, datePolicy.message);
    return false;
  }
  
  selectedDateStr = dateStr;
  
  // 달력 연/월 업데이트 (이전/다음 달 클릭 대비)
  const d = new Date(dateStr);
  currentYear = d.getFullYear();
  currentMonth = d.getMonth();
  
  updateSelectedDateBadge(d);
  
  // 전체 데이터 로드 및 렌더링
  refreshData().then(() => {
    renderAll();
  });
  
  return true;
}

function updateSelectedDateBadge(date) {
  const badge = document.getElementById("selected-date-badge");
  if (!badge) return;
  
  const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
  const dayName = weekdays[date.getDay()];
  badge.textContent = `${date.getFullYear()}년 ${String(date.getMonth() + 1).padStart(2, "0")}월 ${String(date.getDate()).padStart(2, "0")}일 (${dayName})`;
}

function renderAll() {
  updateSelectedDateBadge(new Date(selectedDateStr));
  renderCalendar();
  renderRoomLayout();
  renderTimelineMatrix();
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function checkLogin() {
  if (!currentUser) {
    // 모달 닫고 로그인 유도
    closeReservationModal();
    showToast("로그인이 필요한 서비스입니다.");
    if (KAKAO_APP_KEY && window.Kakao) {
      handleRealKakaoLogin();
    } else {
      let reason = "";
      if (!KAKAO_APP_KEY) reason += "[키 없음] ";
      if (!window.Kakao) reason += "[Kakao SDK 차단/미로드] ";
      console.warn("checkLogin fallback: " + reason);
      openMockLoginModal(reason);
    }
    return false;
  }
  return true;
}

// 모의 로그인 모달 관리
function openMockLoginModal(reason = "") {
  const modal = document.getElementById("mock-login-modal");
  const nicknameInput = document.getElementById("mock-nickname");
  nicknameInput.value = "";
  
  // 디버그 문구 노출
  const debugText = document.getElementById("mock-login-debug-reason");
  if (debugText) {
    if (reason) {
      debugText.textContent = `실시간 카카오 로그인 제한 사유: ${reason}`;
      debugText.style.display = "block";
    } else {
      debugText.style.display = "none";
    }
  }
  
  modal.classList.remove("hidden");
}

function closeMockLoginModal() {
  const modal = document.getElementById("mock-login-modal");
  modal.classList.add("hidden");
}

function submitMockLogin() {
  const nickname = document.getElementById("mock-nickname").value.trim();
  if (!nickname) {
    showToast("닉네임을 입력해주십시오.");
    return;
  }
  
  const mockUser = {
    id: `mock_${Date.now()}_${Math.floor(Math.random()*1000)}`,
    nickname: nickname,
    profile_image: null
  };
  
  saveUserSession(mockUser);
  closeMockLoginModal();
}

// 토스트 메시지 출력
let toastTimer = null;
function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  
  toast.textContent = message;
  toast.classList.add("show");
  
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 2200);
}

// 이벤트 리스너 중앙 바인딩
function setupEventListeners() {
  // 모드 변경 버튼 바인딩
  document.querySelectorAll(".view-mode-button").forEach(btn => {
    btn.addEventListener("click", () => {
      setViewMode(btn.dataset.mode);
    });
  });
  
  // 로그인 / 로그아웃 버튼 바인딩
  document.getElementById("btn-login").addEventListener("click", () => {
    if (KAKAO_APP_KEY && window.Kakao) {
      handleRealKakaoLogin();
    } else {
      let reason = "";
      if (!KAKAO_APP_KEY) reason += "[키 없음] ";
      if (!window.Kakao) reason += "[Kakao SDK 차단/미로드] ";
      showToast("모의 로그인 대체 사유: " + reason);
      openMockLoginModal(reason);
    }
  });
  
  document.getElementById("btn-logout").addEventListener("click", () => {
    clearUserSession();
  });
  
  // 달력 월 이동 버튼 바인딩
  document.getElementById("prev-month").addEventListener("click", () => {
    navigateMonth(-1);
  });
  document.getElementById("next-month").addEventListener("click", () => {
    navigateMonth(1);
  });
  
  // 새로고침 버튼 바인딩
  document.getElementById("refresh-btn").addEventListener("click", async () => {
    await refreshData();
    renderAll();
    showToast("예약 현황이 갱신되었습니다.");
  });
  
  // 예약 모달 폼 이벤트 바인딩
  document.getElementById("modal-close-btn").addEventListener("click", closeReservationModal);
  document.getElementById("modal-cancel-btn").addEventListener("click", closeReservationModal);
  document.getElementById("modal-confirm-btn").addEventListener("click", submitReservation);
  
  // 자주 쓰는 사용 목적 칩 바인딩
  document.querySelectorAll(".quick-purpose-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      const input = document.getElementById("modal-title-input");
      if (input) {
        input.value = chip.dataset.text;
        input.focus();
      }
    });
  });
  
  // 모달 외부 영역(오버레이 배경) 클릭 시 닫기
  document.getElementById("reservation-modal").addEventListener("click", (e) => {
    if (e.target.id === "reservation-modal") {
      closeReservationModal();
    }
  });
  
  // 모의 로그인 모달 버튼 바인딩
  document.getElementById("mock-login-close").addEventListener("click", closeMockLoginModal);
  document.getElementById("mock-login-cancel").addEventListener("click", closeMockLoginModal);
  document.getElementById("mock-login-submit").addEventListener("click", submitMockLogin);
  
  // 상세조회 모달 버튼 바인딩
  document.getElementById("detail-modal-close").addEventListener("click", () => {
    document.getElementById("reservation-detail-modal").classList.add("hidden");
  });
  document.getElementById("detail-close-btn").addEventListener("click", () => {
    document.getElementById("reservation-detail-modal").classList.add("hidden");
  });
  document.getElementById("detail-delete-btn").addEventListener("click", () => {
    document.getElementById("detail-view-container").classList.add("hidden");
    document.getElementById("detail-confirm-container").classList.remove("hidden");
  });
  document.getElementById("detail-confirm-no-btn").addEventListener("click", () => {
    document.getElementById("detail-confirm-container").classList.add("hidden");
    document.getElementById("detail-view-container").classList.remove("hidden");
  });
  document.getElementById("detail-confirm-yes-btn").addEventListener("click", cancelReservationSilent);
  
  // 상세조회 모달 외부 영역(오버레이 배경) 클릭 시 닫기
  document.getElementById("reservation-detail-modal").addEventListener("click", (e) => {
    if (e.target.id === "reservation-detail-modal") {
      document.getElementById("reservation-detail-modal").classList.add("hidden");
    }
  });
  
  // 전역 마우스 업 감지하여 드래그 상태 해제
  document.addEventListener("mouseup", () => {
    isDraggingSlots = false;
    lastTouchedSlotTime = "";
    const existingBar = document.getElementById("matrix-dynamic-selecting-bar");
    if (existingBar) {
      existingBar.remove();
    }
    if (isTimelineDragging) {
      isTimelineDragging = false;
      handleTimelineDragEnd();
    }
  });
  
  document.addEventListener("touchend", () => {
    isDraggingSlots = false;
    lastTouchedSlotTime = "";
    touchDragAnchorSlotIdx = -1;
    if (isTimelineTouchSelectMode) return;
    clearTimelineLongPress();
    if (isTimelineDragging) {
      isTimelineDragging = false;
      handleTimelineDragEnd();
    }
  });
  
  document.addEventListener("touchcancel", () => {
    isDraggingSlots = false;
    lastTouchedSlotTime = "";
    touchDragAnchorSlotIdx = -1;
    clearTimelineLongPress();
    if (isTimelineTouchSelectMode) return;
    if (isTimelineDragging) {
      finishTimelinePointerSelection({ cancelled: true });
    }
  });
  
  // 하단 타임라인 날짜 네비게이션 버튼 바인딩
  document.getElementById("timeline-prev-day-btn").addEventListener("click", () => {
    navigateDay(-1);
  });
  document.getElementById("timeline-next-day-btn").addEventListener("click", () => {
    navigateDay(1);
  });
}

function navigateMonth(offset) {
  const previousYear = currentYear;
  const previousMonth = currentMonth;
  const previousSelectedDateStr = selectedDateStr;
  
  currentMonth += offset;
  if (currentMonth < 0) {
    currentMonth = 11;
    currentYear -= 1;
  } else if (currentMonth > 11) {
    currentMonth = 0;
    currentYear += 1;
  }
  
  // 날짜 선택 기준일 구하기 (달을 이동해도 오늘이 있는 달이면 오늘로, 아니면 해당 달 1일로 지정)
  const today = new Date();
  if (today.getFullYear() === currentYear && today.getMonth() === currentMonth) {
    selectedDateStr = formatDate(today);
  } else {
    selectedDateStr = formatDate(new Date(currentYear, currentMonth, 1));
  }
  
  const selected = selectDate(selectedDateStr);
  if (!selected) {
    currentYear = previousYear;
    currentMonth = previousMonth;
    selectedDateStr = previousSelectedDateStr;
  }
}

function navigateDay(offset) {
  const currentDate = new Date(selectedDateStr);
  currentDate.setDate(currentDate.getDate() + offset);
  
  const newDateStr = formatDate(currentDate);

  const badge = document.getElementById("selected-date-badge");
  selectDate(newDateStr, badge);
}

// 12. 공통 도우미 함수 (Cookie, Date 포맷 등)
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Cookie helpers
function setCookie(name, value, days) {
  let expires = "";
  if (days) {
    const date = new Date();
    date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
    expires = "; expires=" + date.toUTCString();
  }
  document.cookie = name + "=" + (value || "") + expires + "; path=/";
}

function getCookie(name) {
  const nameEQ = name + "=";
  const ca = document.cookie.split(';');
  for (let i = 0; i < ca.length; i++) {
    let c = ca[i];
    while (c.charAt(0) === ' ') c = c.substring(1, c.length);
    if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length, c.length);
  }
  return null;
}

function deleteCookie(name) {
  document.cookie = name + '=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';
}

// 13. 예약 제한 정책 및 말풍선 기능 구현
function getMaxAllowedBookingDate(now) {
  const currentSunday = new Date(now);
  currentSunday.setDate(now.getDate() - now.getDay());
  currentSunday.setHours(0, 0, 0, 0);
  
  const currentSaturday = new Date(currentSunday);
  currentSaturday.setDate(currentSunday.getDate() + 6);
  currentSaturday.setHours(23, 59, 59, 999);
  
  const openTimeThisSaturday = new Date(currentSaturday);
  openTimeThisSaturday.setHours(WEEKLY_BOOKING_OPEN_HOUR, 0, 0, 0);
  
  if (now >= openTimeThisSaturday) {
    const nextSaturday = new Date(currentSaturday);
    nextSaturday.setDate(currentSaturday.getDate() + 7);
    nextSaturday.setHours(23, 59, 59, 999);
    return nextSaturday;
  } else {
    return currentSaturday;
  }
}

function checkDateReservationAllowed(dateStr) {
  const now = new Date();
  const targetDate = new Date(dateStr);
  targetDate.setHours(0, 0, 0, 0);
  
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (targetDate < today) {
    return { 
      allowed: false, 
      reason: "past",
      message: "지난 날짜는 예약하거나 변경할 수 없습니다."
    };
  }
  
  const maxAllowedDate = getMaxAllowedBookingDate(now);
  if (targetDate > maxAllowedDate) {
    const targetSunday = new Date(targetDate);
    targetSunday.setDate(targetDate.getDate() - targetDate.getDay());
    
    const unlockSaturday = new Date(targetSunday);
    unlockSaturday.setDate(targetSunday.getDate() - 1);
    
    const month = unlockSaturday.getMonth() + 1;
    const date = unlockSaturday.getDate();
    return { 
      allowed: false, 
      reason: "locked", 
      message: `돌아오는 ${month}월 ${date}일(토) ${WEEKLY_BOOKING_OPEN_HOUR}:00에 예약 가능`
    };
  }
  
  return { allowed: true };
}

function showFloatingTooltip(element, message) {
  document.querySelectorAll(".calendar-floating-tooltip").forEach(el => el.remove());
  
  const tooltip = document.createElement("div");
  tooltip.classList.add("calendar-floating-tooltip");
  tooltip.textContent = message;
  
  document.body.appendChild(tooltip);
  
  const rect = element.getBoundingClientRect();
  const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
  const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
  
  tooltip.style.left = `${rect.left + rect.width / 2 + scrollLeft}px`;
  tooltip.style.top = `${rect.top - 8 + scrollTop}px`;
  
  setTimeout(() => {
    tooltip.style.opacity = "0";
    setTimeout(() => tooltip.remove(), 300);
  }, 2500);
}
