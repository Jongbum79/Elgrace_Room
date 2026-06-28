#!/bin/bash
# GitHub Pages 자동 배포 및 업데이트 스크립트
# 사용법: ./deploy.sh "커밋 메시지"

# 커밋 메시지가 입력되지 않았다면 기본 메시지 지정
if [ -z "$1" ]; then
  COMMIT_MSG="공간예약시스템 업데이트"
else
  COMMIT_MSG="$1"
fi

echo "🚀 [1/3] 변경된 파일들을 선택합니다..."
git add index.html app.js styles.css room_layout_data.json schema.sql server.py deploy.sh .gitignore .nojekyll

echo "💾 [2/3] 커밋(저장)을 생성합니다: \"$COMMIT_MSG\""
git commit -m "$COMMIT_MSG"

# 원격 레포지토리가 설정되었는지 확인 후 푸시 진행
if git remote | grep -q "origin"; then
  echo "📤 [3/3] GitHub 원격 서버로 코드를 보냅니다..."
  git push origin main
  echo "✅ 배포 요청 완료! 약 1분 후 실제 웹사이트(GitHub Pages)에 업데이트가 반영됩니다."
else
  echo "⚠️  [주의] git remote 'origin'이 등록되지 않았습니다."
  echo "깃허브 레포지토리를 만드신 후 아래 명령어로 연결해주십시오:"
  echo "   git remote add origin <깃허브_주소>"
  echo "그 다음 'git push -u origin main'을 최초 1회 수동으로 실행해주십시오."
fi
