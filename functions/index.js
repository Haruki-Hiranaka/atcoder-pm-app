const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");

admin.initializeApp();
const db = admin.firestore();

const CSV_URL = "https://raw.githubusercontent.com/Haruki-Hiranaka/atcoder_app/main/atcoder_problems.csv";
const STATUS_CIRCLE = "circle";

// CSVデータを取得・解析する共通関数
const fetchAndParseCSV = async () => {
    const response = await axios.get(CSV_URL);
    const csvText = response.data;
    const lines = csvText.trim().split(/\r?\n/);
    const header = lines[0].split(",").map((h) => h.trim());
    return lines.slice(1).map((line) => {
        if (!line) return null;
        const values = line.split(",").map((v) => v.trim());
        if (values.length !== header.length) return null;
        return header.reduce((obj, key, i) => {
            obj[key] = values[i] || "";
            return obj;
        }, {});
    }).filter(Boolean);
};

// ランキング計算ロジック
const calculateAndSaveRanking = async () => {
    try {
        const problemsData = await fetchAndParseCSV();
        const problemPoints = new Map();
        problemsData.forEach((p) => {
            if (p.task_screen_name && p.point) {
                problemPoints.set(p.task_screen_name, parseInt(p.point, 10) || 0);
            }
        });

        const usersProgressSnapshot = await db.collection("userProgress").get();
        const allUsersStates = [];
        usersProgressSnapshot.forEach((doc) => {
            allUsersStates.push({ uid: doc.id, ...doc.data() });
        });

        const userRecords = await admin.auth().listUsers();
        const userEmailMap = new Map();
        userRecords.users.forEach((user) => {
            userEmailMap.set(user.uid, user.email);
        });

        const ranking = allUsersStates.map((userProgress) => {
            let score = 0;
            const userStates = userProgress.states || {};
            
            for (const problemId in userStates) {
                const problemStateObj = userStates[problemId];
                if (typeof problemStateObj !== 'object' || problemStateObj === null || !Array.isArray(problemStateObj.states)) continue;
                const states = problemStateObj.states || [];
                
                if (states.length > 0) {
                    const lastState = states[states.length - 1];
                    const lastStateType = typeof lastState === "object" && lastState !== null ? lastState.type : lastState;
                    
                    if (lastStateType === STATUS_CIRCLE) {
                        score += problemPoints.get(problemId) || 0;
                    }
                }
            }
            return {
                uid: userProgress.uid,
                email: userEmailMap.get(userProgress.uid) || "Unknown User",
                score: score,
            };
        });

        ranking.sort((a, b) => b.score - a.score);

        await db.collection("rankings").doc("leaderboard").set({
            users: ranking,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        
        console.log("Ranking update successfully completed.");
        return { success: true, message: "Ranking updated successfully." };

    } catch (error) {
        console.error("Error updating ranking:", error);
        throw new functions.https.HttpsError('internal', 'Failed to update ranking.', error);
    }
};

// ▼▼▼【修正点】定時実行(updateRanking)を削除し、呼び出し可能な関数のみにする ▼▼▼
exports.refreshRanking = functions.https.onCall(async (data, context) => {
    // 認証済みユーザーでなければエラーを返す
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    
    console.log(`Ranking refresh triggered by user: ${context.auth.uid}`);
    
    // ランキング計算を実行
    return await calculateAndSaveRanking();
});