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
const KAKAO_APP_KEY = ""; // 카카오 자바스크립트 키 (입력 시 실연동 작동)

let supabaseClient = null;
let roomLayout = null; // room_layout_data.json 저장용
let reservations = []; // Supabase에서 로드된 예약 리스트

// 현재 달력 포커스 월
let currentYear = new Date().getFullYear();
let currentMonth = new Date().getMonth(); // 0-indexed

// 선택된 날짜 및 상태
let selectedDateStr = formatDate(new Date()); 
let currentUser = null;
let currentViewMode = "desktop"; // desktop | mobile

// 시간 슬롯 리스트 (09:00 ~ 21:00, 30분 단위)
const TIME_SLOTS = [];
for (let h = 9; h < 21; h++) {
  const hourStr = String(h).padStart(2, "0");
  TIME_SLOTS.push(`${hourStr}:00`);
  TIME_SLOTS.push(`${hourStr}:30`);
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
  } else {
    console.error("Supabase SDK를 로드할 수 없습니다.");
  }
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
async function refreshData() {
  if (!supabaseClient) return;
  
  const refreshBtn = document.getElementById("refresh-btn");
  if (refreshBtn) refreshBtn.classList.add("spinning");
  
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
    showToast("예약 현황을 불러오지 못했습니다.");
  } finally {
    if (refreshBtn) {
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
  
  window.Kakao.Auth.login({
    success: function(authObj) {
      window.Kakao.API.request({
        url: '/v2/user/me',
        success: function(res) {
          const kakaoAccount = res.kakao_account;
          const user = {
            id: `kakao_${res.id}`,
            nickname: kakaoAccount.profile.nickname,
            profile_image: kakaoAccount.profile.profile_image_url
          };
          saveUserSession(user);
        },
        fail: function(err) {
          console.error("Kakao 프로필 페치 에러:", err);
          showToast("카카오 사용자 정보를 가져오지 못했습니다.");
        }
      });
    },
    fail: function(err) {
      console.error("Kakao Auth 에러:", err);
      showToast("카카오 로그인을 완료하지 못했습니다.");
    }
  });
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
      
      // 방 종류에 따른 색상 구분 (교육관 등은 파랑, 소그룹은 주황, 영유아 등은 초록)
      if (res.room_name.includes("교육관")) {
        pill.classList.add("res-pill-blue");
      } else if (res.room_name.includes("소그룹")) {
        pill.classList.add("res-pill-orange");
      } else {
        pill.classList.add("res-pill-emerald");
      }
      
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
      selectDate(dateStr);
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
  const popover = document.getElementById("reservation-popover");
  
  if (!svg || !roomLayout) return;
  
  // 기존 동적 콘텐츠 클리어 (정적 엘리먼트 외 청소)
  svg.innerHTML = "";
  
  // 예약 팝오버 닫기
  popover.classList.add("hidden");
  
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
        // 예약 슬롯 수 계산 (30분 단위 슬롯 24개)
        let bookedSlotsCount = 0;
        roomRes.forEach(res => {
          const startIndex = TIME_SLOTS.indexOf(res.start_time);
          const endIndex = TIME_SLOTS.indexOf(res.end_time);
          if (startIndex !== -1 && endIndex !== -1) {
            bookedSlotsCount += (endIndex - startIndex);
          }
        });
        
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
        openReservationPopover(r, e);
      });
    }
    
    // 텍스트 라벨 추가
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", r.x + r.width / 2);
    text.setAttribute("y", r.y + r.height / 2);
    text.setAttribute("class", `room-text ${!r.is_reservable ? "room-text-utility" : ""}`);
    
    // 긴 텍스트 줄바꿈/잘림 가공 (교육관 1 (구 대학부실...) -> 교육관 1)
    let displayName = r.text;
    if (displayName.includes("(")) {
      displayName = displayName.split("(")[0].trim();
    }
    text.textContent = displayName;
    
    svg.appendChild(text);
  });
}

// 7. 예약 시간 선택용 floating 팝오버 관리
let selectedPopoverSlots = [];
let selectedPopoverRoom = null;
let isDraggingSlots = false;

function openReservationPopover(room, event) {
  if (!checkLogin()) return;
  
  selectedPopoverRoom = room;
  selectedPopoverSlots = [];
  
  const popover = document.getElementById("reservation-popover");
  const popoverRoomName = document.getElementById("popover-room-name");
  const popoverDate = document.getElementById("popover-date");
  const popoverSlotsGrid = document.getElementById("popover-slots-grid");
  const titleInput = document.getElementById("popover-title-input");
  
  // 타이틀 초기화
  titleInput.value = "";
  
  // 메타 정보 표시
  popoverRoomName.textContent = room.text;
  popoverDate.textContent = selectedDateStr;
  
  // 현재 날짜/방의 예약 상황 추출
  const roomRes = reservations.filter(res => res.date === selectedDateStr && res.room_id === room.id);
  
  // 30분 단위 슬롯 생성
  popoverSlotsGrid.innerHTML = "";
  
  TIME_SLOTS.forEach(time => {
    const chip = document.createElement("div");
    chip.classList.add("time-slot-chip");
    chip.textContent = time;
    chip.dataset.time = time;
    
    // 이미 예약되었는지 여부 확인
    const isBooked = roomRes.some(res => {
      const startIndex = TIME_SLOTS.indexOf(res.start_time);
      const endIndex = TIME_SLOTS.indexOf(res.end_time);
      const currentIndex = TIME_SLOTS.indexOf(time);
      return currentIndex >= startIndex && currentIndex < endIndex;
    });
    
    if (isBooked) {
      chip.classList.add("booked");
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
    }
    
    popoverSlotsGrid.appendChild(chip);
  });
  
  // 팝오버 위치 결정
  popover.classList.remove("hidden");
  
  // 클릭한 사각형 좌표 얻기
  const svg = document.getElementById("room-layout-svg");
  const svgRect = svg.getBoundingClientRect();
  const scaleX = svgRect.width / 1000;
  const scaleY = svgRect.height / 595;
  
  // 방 사각형 중앙 좌표 계산
  const roomCenterX = (room.x + room.width / 2) * scaleX;
  const roomCenterY = room.y * scaleY;
  
  // 팝오버 배치 오프셋 계산 (중앙 정렬)
  popover.style.left = `${roomCenterX - 140}px`; // width 280px / 2 = 140
  
  // 방 y좌표가 높으면 팝오버를 밑으로, 낮으면 위로 띄움
  if (room.y < 250) {
    popover.style.top = `${(room.y + room.height) * scaleY + 12}px`;
    popover.className = "reservation-popover arrow-top";
  } else {
    popover.style.top = `${roomCenterY - popover.offsetHeight - 12}px`;
    popover.className = "reservation-popover arrow-bottom";
  }
  
  // 방이 화면 양옆으로 튀어나갈 경우 보정
  const leftPx = parseFloat(popover.style.left);
  if (leftPx < 10) {
    popover.style.left = "10px";
  } else if (leftPx + 290 > svgRect.width) {
    popover.style.left = `${svgRect.width - 290}px`;
  }
}

function toggleSlotSelection(time, chipElement) {
  if (chipElement.classList.contains("booked")) return;
  
  const index = selectedPopoverSlots.indexOf(time);
  if (index === -1) {
    selectedPopoverSlots.push(time);
    chipElement.classList.add("selected");
  } else {
    selectedPopoverSlots.splice(index, 1);
    chipElement.classList.remove("selected");
  }
  
  // 선택 슬롯들 정렬
  selectedPopoverSlots.sort((a, b) => TIME_SLOTS.indexOf(a) - TIME_SLOTS.indexOf(b));
}

function closeReservationPopover() {
  const popover = document.getElementById("reservation-popover");
  popover.classList.add("hidden");
  selectedPopoverRoom = null;
  selectedPopoverSlots = [];
}

// 8. 하단 타임라인 예약 매트릭스 렌더링
let isTimelineDragging = false;
let dragStartSlotIdx = -1;
let dragEndSlotIdx = -1;
let dragRoomId = "";

function renderTimelineMatrix() {
  const table = document.getElementById("timeline-matrix-table");
  if (!table || !roomLayout) return;
  
  table.innerHTML = "";
  
  // 1. 헤더 행 생성 (공간명 + 30분 단위 슬롯 컬럼)
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  
  const thRoom = document.createElement("th");
  thRoom.textContent = "공간 목록";
  headerRow.appendChild(thRoom);
  
  TIME_SLOTS.forEach(time => {
    const thTime = document.createElement("th");
    // 정각만 텍스트 노출하고 30분 단위는 보더만 나누어 심플하게 표현 (Linear 스타일)
    if (time.endsWith(":00")) {
      thTime.textContent = time.split(":")[0] + "시";
    } else {
      thTime.textContent = "";
    }
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
      const startIdx = TIME_SLOTS.indexOf(res.start_time);
      const endIdx = TIME_SLOTS.indexOf(res.end_time);
      for (let idx = startIdx; idx < endIdx; idx++) {
        if (idx !== -1) slotBookingMap[idx] = res;
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
          
          if (room.text.includes("교육관")) {
            bar.classList.add("bg-bar-blue");
          } else if (room.text.includes("소그룹")) {
            bar.classList.add("bg-bar-orange");
          } else {
            bar.classList.add("bg-bar-emerald");
          }
          
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
          if (!checkLogin()) return;
          isTimelineDragging = true;
          dragRoomId = room.id;
          dragStartSlotIdx = idx;
          dragEndSlotIdx = idx;
          tdCell.classList.add("drag-selecting");
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
      }
      
      row.appendChild(tdCell);
    }
    
    tbody.appendChild(row);
  });
  
  table.appendChild(tbody);
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
        const start = TIME_SLOTS.indexOf(res.start_time);
        const end = TIME_SLOTS.indexOf(res.end_time);
        return idx >= start && idx < end;
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
      // 해당 방 기준으로 예약 popover 트리거 및 슬롯 설정
      openReservationPopover(room, {
        stopPropagation: () => {},
        preventDefault: () => {}
      });
      
      // 팝오버의 칩 선택 상태 동기화
      selectedPopoverSlots = dragSlots;
      document.querySelectorAll(".time-slot-chip").forEach(chip => {
        const time = chip.dataset.time;
        if (dragSlots.includes(time)) {
          chip.classList.add("selected");
        } else {
          chip.classList.remove("selected");
        }
      });
    }
  }
  
  dragRoomId = "";
  dragStartSlotIdx = -1;
  dragEndSlotIdx = -1;
}

// 타임라인 내 드래그 범위 하이라이트 계산
function highlightTimelineDragSelection(roomId) {
  const minIdx = Math.min(dragStartSlotIdx, dragEndSlotIdx);
  const maxIdx = Math.max(dragStartSlotIdx, dragEndSlotIdx);
  
  document.querySelectorAll(".matrix-cell").forEach(cell => {
    if (cell.dataset.roomId === roomId) {
      const idx = parseInt(cell.dataset.slotIdx);
      if (idx >= minIdx && idx <= maxIdx && !cell.classList.contains("booked")) {
        cell.classList.add("drag-selecting");
      } else {
        cell.classList.remove("drag-selecting");
      }
    }
  });
}

// 9. 예약 삽입 (Supabase INSERT)
async function submitReservation() {
  if (!checkLogin()) return;
  if (!selectedPopoverRoom) return;
  
  const titleInput = document.getElementById("popover-title-input");
  const title = titleInput.value.trim();
  
  if (selectedPopoverSlots.length === 0) {
    showToast("예약할 시간 슬롯을 드래그 또는 클릭하여 선택하십시오.");
    return;
  }
  
  if (!title) {
    showToast("사용 목적을 입력하십시오.");
    titleInput.focus();
    return;
  }
  
  // 시작 시간과 종료 시간 유추 (연속된 시간의 최솟값 ~ 최댓값 + 30분)
  selectedPopoverSlots.sort((a, b) => TIME_SLOTS.indexOf(a) - TIME_SLOTS.indexOf(b));
  
  // 연속성 검증
  const indices = selectedPopoverSlots.map(t => TIME_SLOTS.indexOf(t));
  for (let i = 0; i < indices.length - 1; i++) {
    if (indices[i + 1] - indices[i] !== 1) {
      showToast("예약은 중단 없이 연속된 시간대만 선택 가능합니다.");
      return;
    }
  }
  
  const startTime = selectedPopoverSlots[0];
  const lastSelectedIdx = TIME_SLOTS.indexOf(selectedPopoverSlots[selectedPopoverSlots.length - 1]);
  
  // 종료 시간은 마지막 선택 슬롯의 30분 뒤
  let endTime = "";
  if (lastSelectedIdx === TIME_SLOTS.length - 1) {
    endTime = "21:00";
  } else {
    endTime = TIME_SLOTS[lastSelectedIdx + 1];
  }
  
  const payload = {
    room_id: selectedPopoverRoom.id,
    room_name: selectedPopoverRoom.text,
    date: selectedDateStr,
    start_time: startTime,
    end_time: endTime,
    title: title,
    reserved_by: currentUser.nickname,
    user_id: currentUser.id
  };
  
  try {
    const { data, error } = await supabaseClient
      .from("room_reservations")
      .insert([payload]);
      
    if (error) throw error;
    
    showToast("예약이 성공적으로 등록되었습니다.");
    closeReservationPopover();
    
    // 데이터 새로고침 및 UI 갱신
    await refreshData();
    renderAll();
  } catch (error) {
    console.error("예약 생성 에러:", error);
    showToast("예약을 처리하는 동안 오류가 발생했습니다.");
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
  
  roomName.textContent = res.room_name;
  dateTime.textContent = `${res.date}  |  ${res.start_time} ~ ${res.end_time}`;
  title.textContent = res.title;
  user.textContent = res.reserved_by;
  
  // 본인의 예약인 경우에만 예약 취소 버튼 활성화
  if (currentUser && res.user_id === currentUser.id) {
    delBtn.classList.remove("hidden");
  } else {
    delBtn.classList.add("hidden");
  }
  
  modal.classList.remove("hidden");
}

async function cancelReservation() {
  if (!activeReservationForDetail || !checkLogin()) return;
  
  if (activeReservationForDetail.user_id !== currentUser.id) {
    showToast("본인의 예약만 취소할 수 있습니다.");
    return;
  }
  
  if (!confirm("정말로 이 예약을 취소하시겠습니까?")) return;
  
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
function selectDate(dateStr) {
  selectedDateStr = dateStr;
  
  // 달력 연/월 업데이트 (이전/다음 달 클릭 대비)
  const d = new Date(dateStr);
  currentYear = d.getFullYear();
  currentMonth = d.getMonth();
  
  // 타임라인 선택 라벨 변경
  const badge = document.getElementById("selected-date-badge");
  if (badge) {
    const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
    const dayName = weekdays[d.getDay()];
    badge.textContent = `${d.getFullYear()}년 ${String(d.getMonth() + 1).padStart(2, "0")}월 ${String(d.getDate()).padStart(2, "0")}일 (${dayName})`;
  }
  
  // 전체 데이터 로드 및 렌더링
  refreshData().then(() => {
    renderAll();
  });
}

function renderAll() {
  renderCalendar();
  renderRoomLayout();
  renderTimelineMatrix();
}

function checkLogin() {
  if (!currentUser) {
    // 팝오버 닫고 로그인 유도
    closeReservationPopover();
    showToast("로그인이 필요한 서비스입니다.");
    openMockLoginModal();
    return false;
  }
  return true;
}

// 모의 로그인 모달 관리
function openMockLoginModal() {
  const modal = document.getElementById("mock-login-modal");
  const nicknameInput = document.getElementById("mock-nickname");
  nicknameInput.value = "";
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
      openMockLoginModal();
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
  
  // 팝오버 폼 이벤트 바인딩
  document.getElementById("popover-close-btn").addEventListener("click", closeReservationPopover);
  document.getElementById("popover-cancel-btn").addEventListener("click", closeReservationPopover);
  document.getElementById("popover-confirm-btn").addEventListener("click", submitReservation);
  
  // 팝오버 외부 영역 클릭 시 닫기
  document.addEventListener("click", (e) => {
    const popover = document.getElementById("reservation-popover");
    if (!popover.classList.contains("hidden") && !popover.contains(e.target)) {
      // SVG 내 도형을 클릭한 게 아니라면 닫기
      if (!e.target.classList.contains("room-shape")) {
        closeReservationPopover();
      }
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
  document.getElementById("detail-delete-btn").addEventListener("click", cancelReservation);
  
  // 전역 마우스 업 감지하여 드래그 상태 해제
  document.addEventListener("mouseup", () => {
    isDraggingSlots = false;
    if (isTimelineDragging) {
      isTimelineDragging = false;
      handleTimelineDragEnd();
    }
  });
}

function navigateMonth(offset) {
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
  
  selectDate(selectedDateStr);
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
