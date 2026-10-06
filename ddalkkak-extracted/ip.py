"""
IPTime N904 공유기 - WAN IP 강제 변경 (MAC 주소 변경 + 연결 해제 방식)

실제 브라우저 Network/View-Source 캡처로 전부 확인된 사실:

1. 인증: HTTP Basic Auth (세션 로그인 폼 아님). 모든 요청에 Authorization: Basic 헤더가 붙음.

2. 실제 WAN 설정 폼 페이지: tmenu=netconf&smenu=wansetup
   (기존에 쓰던 tmenu=main_frame&smenu=main_frame 은 프레임 껍데기만 반환해서
    WAN IP를 못 읽었음 - 이번에 고침)
   이 페이지의 "외부 IP/서브넷/게이트웨이" 칸은 id="disabled_dynamicip1~4" 등으로
    disabled 되어 있지만 value는 그대로 들어있어 읽을 수 있음.
   DNS는 name="fdns_dynamic1~4" / "sdns_dynamic1~4".
   MAC 주소 입력칸은 name="hw_dynamic1~6" (동적 IP 모드 기준), 체크박스는
    name="hw_conf_dynamic" (기본으로 이미 체크되어 있어 MAC 필드가 항상 활성 상태).

3. "적용" 버튼(apply_wansetup JS 함수)은 보이는 폼을 그대로 제출하지 않고,
   숨은 iframe 폼에 값을 복사한 뒤 아래로 POST함:
     tmenu=iframe&smenu=hiddenwansetup&act=save&wan=wan1&ifname=eth1&nopassword=0
     &wan_type=dynamic&hw_conf_dynamic=on
     &hw_dynamic1=XX&hw_dynamic2=XX&...&hw_dynamic6=XX
   (DNS 수동입력/MTU 수동입력 체크박스가 꺼져 있으면 그 필드들은 disabled 상태라
    전송되지 않음 - 기본 상태라 이 스크립트도 생략함)

4. "연결 해제" 버튼은 별도로 아래를 POST함 (이것도 실제 캡처로 100% 확인됨):
     menu=iframe&smenu=hiddenwanstatus&wan=wan1&wan_type=dynamic
     &fdns=...&sdns=...&ip=...&sm=...&gw=...&buttonact=disconnect
   동적 IP라 해제 후 공유기가 자동 재연결을 시도함.
"""

import os
import requests
from requests.auth import HTTPBasicAuth
import re
import random
import time
import sys

# ============================================================
# 설정
# ============================================================
ROUTER_IP = os.environ.get("ROUTER_IP", "http://192.168.0.1")
ROUTER_ID = os.environ.get("ROUTER_ID", "")
ROUTER_PW = os.environ.get("ROUTER_PW", "")

WAIT_AFTER_CHANGE = 15               # MAC 변경/연결 해제 후 재연결 대기 시간(초)
MAX_ATTEMPTS = 5                     # 최대 시도 횟수
REQUEST_TIMEOUT = 8                  # 요청 타임아웃(초)

USE_MAC_CHANGE = True                # MAC 주소도 함께 바꿀지 여부


# ============================================================
# 유틸
# ============================================================
def log(msg):
    print(f"[*] {msg}")

def error(msg):
    print(f"[!] {msg}")

def ok(msg):
    print(f"[성공] {msg}")

def debug_response(label, res):
    """문제 진단용: 응답 상태코드와 본문 일부를 그대로 보여줍니다."""
    snippet = res.text[:200].replace("\n", " ").strip()
    log(f"  [{label}] status={res.status_code}")
    log(f"  [{label}] body(앞 200자)= {snippet!r}")


def random_mac_octets():
    """로컬 유니캐스트 MAC 주소 생성 (6개 옥텟 정수 리스트로 반환)"""
    return [0x00, 0x0C, 0x29, random.randint(0, 255), random.randint(0, 255), random.randint(0, 255)]


def check_router_reachable():
    """공유기 자체에 접속이 되는지부터 확인합니다 (인증 이전 단계)."""
    try:
        res = requests.get(ROUTER_IP, timeout=REQUEST_TIMEOUT)
        log(f"공유기 응답 확인: status={res.status_code}")
        return True
    except requests.exceptions.ConnectTimeout:
        error(f"{ROUTER_IP} 로 연결 시간 초과. PC가 공유기와 같은 네트워크(LAN/Wi-Fi)에 "
              f"연결되어 있는지, 게이트웨이 IP가 정말 192.168.0.1이 맞는지 확인하세요. "
              f"(명령 프롬프트에서 'ipconfig' 실행 후 '기본 게이트웨이' 값 확인)")
        return False
    except requests.exceptions.ConnectionError as e:
        error(f"공유기에 연결할 수 없습니다: {e}")
        return False
    except Exception as e:
        error(f"알 수 없는 연결 오류: {e}")
        return False


def _extract_quad(html, prefix):
    """id="prefix1" value="X" 또는 name="prefix1" value="X" 형태 4칸을 'a.b.c.d'로 합쳐 반환."""
    octets = []
    for i in range(1, 5):
        m = re.search(rf'(?:id|name)="{re.escape(prefix)}{i}"[^>]*?value="(\d{{1,3}})"', html)
        if not m:
            return None
        octets.append(m.group(1))
    return ".".join(octets)


def get_wan_status(session, auth):
    """
    실제 WAN 설정 페이지(tmenu=netconf&smenu=wansetup)에서 현재 외부 IP·서브넷·
    게이트웨이·DNS를 읽어옵니다. (이전 버전은 프레임 껍데기만 반환하는 잘못된 URL을
    사용해서 LAN 네트워크/브로드캐스트 주소만 긁어왔었음 - 이번에 실제 캡처로 고침)
    """
    try:
        res = session.get(f"{ROUTER_IP}/cgi-bin/timepro.cgi",
                          params={"tmenu": "netconf", "smenu": "wansetup"},
                          auth=auth, timeout=REQUEST_TIMEOUT)
    except Exception as e:
        error(f"WAN 상태 조회 실패: {e}")
        return None

    html = res.text
    ip = _extract_quad(html, "disabled_dynamicip")
    sm = _extract_quad(html, "disabled_dynamicsm")
    gw = _extract_quad(html, "disabled_dynamicgw")
    fdns = _extract_quad(html, "fdns_dynamic")
    sdns = _extract_quad(html, "sdns_dynamic")

    if not all([ip, sm, gw]):
        error(f"WAN 상태 페이지에서 IP/서브넷/게이트웨이를 못 찾았습니다. "
              f"ip={ip} sm={sm} gw={gw}. 페이지 구조가 다를 수 있습니다.")
        return None

    return {"ip": ip, "sm": sm, "gw": gw, "fdns": fdns, "sdns": sdns}


def disconnect_wan(session, auth, status):
    """
    실제 브라우저 캡처로 확인된 '연결 해제' 요청. 동적 IP 방식에서는
    해제 후 공유기가 자동으로 재연결을 시도합니다.
    """
    payload = {
        "menu": "iframe",
        "smenu": "hiddenwanstatus",
        "wan": "wan1",
        "wan_type": "dynamic",
        "fdns": status["fdns"] or "",
        "sdns": status["sdns"] or "",
        "ip": status["ip"],
        "sm": status["sm"],
        "gw": status["gw"],
        "buttonact": "disconnect",
    }
    res = session.post(f"{ROUTER_IP}/cgi-bin/timepro.cgi", data=payload, auth=auth, timeout=REQUEST_TIMEOUT)
    debug_response("연결 해제", res)
    return res


def change_wan_mac(session, auth, mac_octets):
    """
    실제 view-source로 확인된 WAN 설정 "적용" 버튼의 실제 제출 대상.
    (apply_wansetup() JS가 숨은 iframe 폼에 값을 복사해 아래로 POST함)
    """
    payload = {
        "tmenu": "iframe",
        "smenu": "hiddenwansetup",
        "act": "save",
        "wan": "wan1",
        "ifname": "eth1",
        "nopassword": "0",
        "wan_type": "dynamic",
        "hw_conf_dynamic": "on",
        "hw_dynamic1": f"{mac_octets[0]:02X}",
        "hw_dynamic2": f"{mac_octets[1]:02X}",
        "hw_dynamic3": f"{mac_octets[2]:02X}",
        "hw_dynamic4": f"{mac_octets[3]:02X}",
        "hw_dynamic5": f"{mac_octets[4]:02X}",
        "hw_dynamic6": f"{mac_octets[5]:02X}",
    }
    res = session.post(f"{ROUTER_IP}/cgi-bin/timepro.cgi", data=payload, auth=auth, timeout=REQUEST_TIMEOUT)
    debug_response("MAC 변경", res)
    return res


# ============================================================
# 메인
# ============================================================
def main():
    log(f"대상 공유기: {ROUTER_IP}")

    if not check_router_reachable():
        error("공유기 자체에 접속이 안 되는 상태입니다. 인증 단계로 넘어가지 않고 중단합니다.")
        sys.exit(1)

    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    })
    auth = HTTPBasicAuth(ROUTER_ID, ROUTER_PW)

    status = get_wan_status(session, auth)
    if not status:
        error("초기 WAN 상태를 읽지 못해 중단합니다.")
        sys.exit(1)
    before_ip = status["ip"]
    log(f"현재 WAN IP: {before_ip}")

    for attempt in range(1, MAX_ATTEMPTS + 1):
        log(f"--- 시도 {attempt}/{MAX_ATTEMPTS} ---")

        if USE_MAC_CHANGE:
            new_mac = random_mac_octets()
            log(f"새 MAC: {'-'.join(f'{b:02X}' for b in new_mac)}")
            try:
                change_wan_mac(session, auth, new_mac)
            except requests.exceptions.RequestException as e:
                error(f"  MAC 변경 요청 실패: {e}")

        try:
            disconnect_wan(session, auth, status)
        except requests.exceptions.RequestException as e:
            error(f"  연결 해제 요청 실패: {e}")

        log(f"  {WAIT_AFTER_CHANGE}초 대기(자동 재연결 대기)...")
        time.sleep(WAIT_AFTER_CHANGE)

        status = get_wan_status(session, auth)
        if not status:
            error("  재연결 후 WAN 상태를 읽지 못했습니다. 계속 재시도합니다.")
            continue
        after_ip = status["ip"]
        log(f"  변경 후 WAN IP: {after_ip}")

        if before_ip and after_ip and before_ip != after_ip:
            ok(f"IP가 {before_ip} → {after_ip} 로 변경되었습니다!")
            return
        else:
            log("  → IP가 바뀌지 않았습니다. 다시 시도합니다.")

    error("IP 변경에 실패했습니다.")
    error("동일 IP가 계속 재할당되는 ISP/상품일 수 있습니다.")


if __name__ == "__main__":
    main()
