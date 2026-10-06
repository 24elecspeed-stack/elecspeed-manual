// Translate known application errors only. Unknown server diagnostics stay verbatim.
(() => {
  const rows = [
    ['새 대화를 시작하지 못했습니다. AI 사이트에서 새 대화를 연 뒤 다시 시도해 주세요. 기존 대화에는 요청을 보내지 않았습니다.', '새 대화를 시작하지 못했습니다. AI 사이트에서 새 대화를 연 뒤 다시 시도해 주세요. 기존 대화에는 요청을 보내지 않았습니다.', 'Could not start a new chat. Open a new chat on the AI site and retry. No request was sent to the existing conversation.', '新しいチャットを開始できませんでした。AIサイトで新しいチャットを開いて再試行してください。既存の会話にはリクエストを送信していません。', 'No se pudo iniciar un chat nuevo. Abre uno en el sitio de IA y vuelve a intentarlo. No se envió ninguna solicitud a la conversación anterior.'],
    ['새 대화 전환을 확인하지 못했습니다. AI 사이트에서 새 대화를 연 뒤 다시 시도해 주세요. 기존 대화에는 요청을 보내지 않았습니다.', '새 대화 전환을 확인하지 못했습니다. AI 사이트에서 새 대화를 연 뒤 다시 시도해 주세요. 기존 대화에는 요청을 보내지 않았습니다.', 'Could not confirm the new chat. Open a new chat on the AI site and retry. No request was sent to the existing conversation.', '新しいチャットへの切り替えを確認できませんでした。AIサイトで新しいチャットを開いて再試行してください。既存の会話にはリクエストを送信していません。', 'No se pudo confirmar el chat nuevo. Abre uno en el sitio de IA y vuelve a intentarlo. No se envió ninguna solicitud a la conversación anterior.'],
    ['Invalid or expired reward page session.', '무료 이용권 페이지 연결이 만료되었거나 올바르지 않습니다. 확장 프로그램에서 광고 페이지를 다시 열어 주세요.', 'The reward page session is invalid or expired. Reopen the ad page from the extension.', '無料利用券ページの接続が無効または期限切れです。拡張機能から広告ページを開き直してください。', 'La sesión de la página de recompensas no es válida o ha caducado. Abre de nuevo la página de anuncios desde la extensión.'],
    ['This reward session has already been used.', '이미 사용한 무료 이용권 페이지입니다. 확장 프로그램에서 다시 열어 주세요.', 'This reward session has already been used. Reopen the page from the extension.', 'この利用券ページはすでに使用されています。拡張機能から開き直してください。', 'Esta sesión de recompensas ya se ha utilizado. Abre de nuevo la página desde la extensión.'],
    ['Device ID is missing.', '기기 식별자가 없습니다. 확장 프로그램에서 다시 접속해 주세요.', 'Device ID is missing. Reopen the page from the extension.', '端末IDがありません。拡張機能から開き直してください。', 'Falta el ID del dispositivo. Abre de nuevo la página desde la extensión.'],
    ['Reward request must originate from the extension panel.', '확장 프로그램 사이드패널에서 무료 이용권을 요청해 주세요.', 'Request the free pass from the extension side panel.', '拡張機能のサイドパネルから無料利用券を申請してください。', 'Solicita el pase gratuito desde el panel lateral de la extensión.'],
    ['Free pass request rejected.', '무료 이용권 요청이 거절되었습니다. 다시 시도해 주세요.', 'The free pass request was rejected. Please retry.', '無料利用券の申請が拒否されました。再度お試しください。', 'La solicitud del pase gratuito se ha rechazado. Vuelve a intentarlo.'],
    ['Request failed', '요청을 처리하지 못했습니다. 다시 시도해 주세요.', 'The request failed. Please retry.', 'リクエストを処理できませんでした。再度お試しください。', 'La solicitud ha fallado. Vuelve a intentarlo.'],
    ['English mode supports Google Blogger for blog posts.', '이 언어에서는 Google Blogger 글쓰기 화면을 연결해 주세요.', 'Connect a Google Blogger editor for posts in this language.', 'この言語ではGoogle Bloggerの記事作成画面に接続してください。', 'Conecta un editor de Google Blogger para redactar entradas en este idioma.'],
    ['📋 AI 진단 리포트가 복사되었습니다! 채팅창에 붙여넣어 주세요.', '📋 AI 진단 리포트가 복사되었습니다! 채팅창에 붙여넣어 주세요.', '📋 Diagnostic report copied. Paste it into your chat.', '📋 診断レポートをコピーしました。チャットに貼り付けてください。', '📋 Informe de diagnóstico copiado. Pégalo en el chat.']
  ];
  globalThis.ddalkkakErrorText = (source, language = 'en') => {
    const index = ({ko:1,en:2,ja:3,es:4})[language] || 2;
    const text = String(source), clean = text.trim();
    const row = rows.find(values => values.includes(clean));
    return row ? text.replace(clean,row[index]) : text;
  };
})();
