import React, { useState, useEffect, useRef } from "react";
import { db, storage, auth } from "./firebase";
import { collection, doc, setDoc, getDoc, updateDoc, onSnapshot, addDoc, query, orderBy, deleteDoc, serverTimestamp } from "firebase/firestore";
import { ref, uploadString, getDownloadURL } from "firebase/storage";
import { GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";

function App() {
    const [user, setUser] = useState(null);
    const [partnerEmail, setPartnerEmail] = useState(null);
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState("");
    const [showCanvas, setShowCanvas] = useState(false);

    const [searchEmail, setSearchEmail] = useState("");
    const [invitations, setInvitations] = useState([]);

    // 1. 로그인 및 내 정보 감지
    useEffect(() => {
        const unsubscribeAuth = onAuthStateChanged(auth, async (currentUser) => {
            if (currentUser) {
                setUser(currentUser);

                const userDocRef = doc(db, "users", currentUser.email);

                // A. 내 정보 저장 (최초 1회만, merge 옵션 사용)
                // (주의: 여기서 lastActive를 계속 업데이트하면 무한루프 위험이 있으니 필요시에만 하거나 생략)
                await setDoc(
                    userDocRef,
                    {
                        email: currentUser.email,
                        name: currentUser.displayName,
                        photo: currentUser.photoURL,
                        // lastActive: serverTimestamp() // 필요하면 주석 해제 (로그인 시 1회만 실행됨)
                    },
                    { merge: true },
                );

                // B. 내 정보(파트너 연결 여부) 실시간 감지
                const unsubUser = onSnapshot(userDocRef, (docSnap) => {
                    if (docSnap.exists()) {
                        const data = docSnap.data();
                        setPartnerEmail(data.partner || null);
                    }
                });

                // C. 나에게 온 초대장(Subcollection) 실시간 감지
                // users/{내이메일}/invitations 컬렉션을 구독
                const invitationsRef = collection(db, "users", currentUser.email, "invitations");
                const unsubInvites = onSnapshot(invitationsRef, (snapshot) => {
                    const newInvites = snapshot.docs.map((doc) => ({
                        id: doc.id,
                        ...doc.data(),
                    }));
                    setInvitations(newInvites);
                });

                // 클린업 함수에서 리스너 해제
                return () => {
                    unsubUser();
                    unsubInvites();
                };
            } else {
                setUser(null);
                setPartnerEmail(null);
                setMessages([]);
                setInvitations([]);
            }
        });

        return () => unsubscribeAuth();
    }, []);

    // 2. 구글 로그인
    const handleGoogleLogin = async () => {
        try {
            await signInWithPopup(auth, new GoogleAuthProvider());
        } catch (error) {
            console.error(error);
        }
    };

    // 3. 로그아웃
    const handleLogout = () => {
        signOut(auth);
    };

    // 4. 친구 신청 보내기
    const sendInvitation = async () => {
        if (!searchEmail.includes("@")) return alert("이메일 형식을 확인하세요.");
        if (searchEmail === user.email) return alert("자신에게는 신청할 수 없습니다.");

        // A. 상대방이 가입했는지 확인
        const targetUserRef = doc(db, "users", searchEmail);
        const targetSnap = await getDoc(targetUserRef);

        if (targetSnap.exists()) {
            // B. 상대방의 invitations 서브컬렉션에 내 정보 추가
            // (문서 ID를 내 이메일로 지정하여 중복 신청 방지)
            const inviteRef = doc(db, "users", searchEmail, "invitations", user.email);
            await setDoc(inviteRef, {
                fromEmail: user.email,
                fromName: user.displayName,
                fromPhoto: user.photoURL,
                timestamp: serverTimestamp(),
            });
            alert("초대장을 보냈습니다!");
            setSearchEmail("");
        } else {
            alert("가입되지 않은 사용자입니다. 상대방이 먼저 앱에 접속해야 합니다.");
        }
    };

    // 5. 초대 수락하기
    const acceptInvitation = async (invitation) => {
        if (!window.confirm(`${invitation.fromName}님과 연결하시겠습니까?`)) return;

        // A. 내 파트너 정보 업데이트
        await updateDoc(doc(db, "users", user.email), {
            partner: invitation.fromEmail,
        });

        // B. 상대방 파트너 정보 업데이트
        await updateDoc(doc(db, "users", invitation.fromEmail), {
            partner: user.email,
        });

        // C. 초대장 삭제 (수락했으므로)
        await deleteDoc(doc(db, "users", user.email, "invitations", invitation.id));

        // 필요하다면 다른 초대장들도 싹 지우는 로직 추가 가능
        alert("연결되었습니다!");
    };

    // 6. 연결 끊기
    const leaveChat = async () => {
        if (!window.confirm("정말 연결을 끊으시겠습니까?")) return;

        // 내 정보에서 파트너 삭제
        await updateDoc(doc(db, "users", user.email), {
            partner: null,
        });

        // 상대방 정보에서도 파트너 삭제 (선택 사항)
        if (partnerEmail) {
            await updateDoc(doc(db, "users", partnerEmail), {
                partner: null,
            });
        }
        setPartnerEmail(null);
    };

    // 7. 채팅방 ID 생성
    const getRoomId = () => {
        if (!user || !partnerEmail) return null;
        return [user.email, partnerEmail].sort().join("_");
    };

    // 8. 메시지 수신 (Firestore)
    useEffect(() => {
        if (!partnerEmail || !user) return;
        const roomId = getRoomId();

        // rooms/{roomId}/messages 컬렉션 구독
        const q = query(collection(db, "rooms", roomId, "messages"), orderBy("timestamp", "asc"));

        const unsubscribe = onSnapshot(q, (snapshot) => {
            setMessages(snapshot.docs.map((doc) => doc.data()));
        });

        return () => unsubscribe();
    }, [partnerEmail, user]);

    // 9. 메시지 전송 (Firestore)
    const sendMessage = async (text = null, imageUrl = null) => {
        if ((!text && !imageUrl) || !user) return;
        const roomId = getRoomId();

        await addDoc(collection(db, "rooms", roomId, "messages"), {
            senderEmail: user.email,
            senderPhoto: user.photoURL,
            text: text,
            imageUrl: imageUrl,
            timestamp: serverTimestamp(), // Firestore 서버 시간
        });
        setInput("");
    };

    // --- 화면 렌더링 ---
    if (!user) {
        return (
            <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100vh" }}>
                <button onClick={handleGoogleLogin} style={{ padding: "15px 30px", background: "#4285F4", color: "white", border: "none", borderRadius: 5 }}>
                    Google 로그인
                </button>
            </div>
        );
    }

    // 매칭 대기 화면
    if (!partnerEmail) {
        return (
            <div style={{ padding: 20, textAlign: "center", maxWidth: 400, margin: "0 auto" }}>
                <img src={user.photoURL} alt="me" style={{ borderRadius: "50%", width: 60 }} />
                <h3>{user.displayName}님</h3>

                <div style={{ border: "1px solid #ddd", padding: 20, borderRadius: 10, marginTop: 20 }}>
                    <h4>친구 초대하기</h4>
                    <input placeholder="상대방 구글 이메일" value={searchEmail} onChange={(e) => setSearchEmail(e.target.value)} style={{ padding: 10, width: "60%" }} />
                    <button onClick={sendInvitation} style={{ marginLeft: 5, padding: "10px 15px" }}>
                        초대
                    </button>
                </div>

                <div style={{ marginTop: 30 }}>
                    <h4>📩 받은 초대함 ({invitations.length})</h4>
                    {invitations.length === 0 && <p style={{ color: "#888" }}>도착한 초대가 없습니다.</p>}
                    {invitations.map((inv) => (
                        <div
                            key={inv.id}
                            style={{
                                background: "#f9f9f9",
                                padding: 10,
                                margin: "10px 0",
                                borderRadius: 8,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                            }}
                        >
                            <div style={{ textAlign: "left" }}>
                                <b>{inv.fromName}</b>
                                <br />
                                <small>{inv.fromEmail}</small>
                            </div>
                            <button onClick={() => acceptInvitation(inv)} style={{ background: "#4CAF50", color: "white", border: "none", padding: "5px 10px", borderRadius: 5 }}>
                                수락
                            </button>
                        </div>
                    ))}
                </div>
                <button onClick={handleLogout} style={{ marginTop: 50, background: "#eee" }}>
                    로그아웃
                </button>
            </div>
        );
    }

    // 채팅 화면
    return (
        <div style={{ padding: 20, maxWidth: 500, margin: "0 auto", border: "1px solid #ccc", height: "90vh", display: "flex", flexDirection: "column" }}>
            <div style={{ paddingBottom: 10, borderBottom: "1px solid #eee", display: "flex", justifyContent: "space-between" }}>
                <span>
                    ❤️ <b>{partnerEmail}</b>
                </span>
                <button onClick={leaveChat} style={{ background: "#ff4444", color: "white", border: "none", padding: "5px 10px", borderRadius: 5 }}>
                    연결 끊기
                </button>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: 10 }}>
                {messages.map((msg, idx) => {
                    const isMe = msg.senderEmail === user.email;
                    return (
                        <div key={idx} style={{ display: "flex", justifyContent: isMe ? "flex-end" : "flex-start", marginBottom: 10 }}>
                            {!isMe && <img src={msg.senderPhoto} style={{ width: 30, height: 30, borderRadius: "50%", marginRight: 5 }} />}
                            <div style={{ background: isMe ? "#FFEB3B" : "#eee", padding: "8px 12px", borderRadius: 10, maxWidth: "70%" }}>
                                {msg.imageUrl ? <img src={msg.imageUrl} alt="img" style={{ maxWidth: 150 }} /> : msg.text}
                            </div>
                        </div>
                    );
                })}
            </div>

            <div style={{ display: "flex", paddingTop: 10 }}>
                <button onClick={() => setShowCanvas(true)} style={{ marginRight: 5 }}>
                    🎨
                </button>
                <input value={input} onChange={(e) => setInput(e.target.value)} onKeyPress={(e) => e.key === "Enter" && sendMessage(input)} style={{ flex: 1, padding: 10 }} />
                <button onClick={() => sendMessage(input)} style={{ marginLeft: 5 }}>
                    전송
                </button>
            </div>

            {showCanvas && (
                <DrawingCanvas
                    onClose={() => setShowCanvas(false)}
                    onSend={(url) => {
                        sendMessage(null, url);
                        setShowCanvas(false);
                    }}
                />
            )}
        </div>
    );
}

// DrawingCanvas 컴포넌트 (변경 없음)
function DrawingCanvas({ onClose, onSend }) {
    const canvasRef = useRef(null);
    const [isDrawing, setIsDrawing] = useState(false);

    const startDrawing = ({ nativeEvent }) => {
        const { offsetX, offsetY } = nativeEvent;
        const ctx = canvasRef.current.getContext("2d");
        ctx.beginPath();
        ctx.moveTo(offsetX, offsetY);
        setIsDrawing(true);
    };

    const draw = ({ nativeEvent }) => {
        if (!isDrawing) return;
        const { offsetX, offsetY } = nativeEvent;
        const ctx = canvasRef.current.getContext("2d");
        ctx.lineTo(offsetX, offsetY);
        ctx.stroke();
    };

    const uploadDrawing = async () => {
        const dataUrl = canvasRef.current.toDataURL("image/png");
        // Storage 참조 가져오는 방식 확인 (firebase.js에서 가져온 storage 사용)
        const fileRef = ref(storage, `emoticons/${Date.now()}.png`);
        await uploadString(fileRef, dataUrl, "data_url");
        const url = await getDownloadURL(fileRef);
        onSend(url);
    };

    return (
        <div
            style={{
                position: "fixed",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: "rgba(0,0,0,0.5)",
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                zIndex: 999,
            }}
        >
            <div style={{ background: "white", padding: 20, borderRadius: 10 }}>
                <canvas
                    ref={canvasRef}
                    width={300}
                    height={300}
                    style={{ border: "1px solid black" }}
                    onMouseDown={startDrawing}
                    onMouseMove={draw}
                    onMouseUp={() => setIsDrawing(false)}
                />
                <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between" }}>
                    <button onClick={onClose}>취소</button>
                    <button onClick={uploadDrawing}>보내기</button>
                </div>
            </div>
        </div>
    );
}

export default App;
