# SPDX-License-Identifier: GPL-2.0-or-later
# Reference expressions: Copyright Nikolai Kudashov, 2013-2018.
# Modified 2026-10-19: standalone C++ test harness around the Java geometry.
from pathlib import Path
import hashlib
import itertools
import json
import random
import re
import subprocess
import sys
import tempfile

# Generate golden results from the pinned upstream Java expressions, using C++
# float arithmetic. No TypeScript implementation is imported by this oracle.
# Usage: python3 scripts/telegram-album-reference.py /path/to/MessageObject.java
# Source: https://github.com/DrKLO/Telegram/blob/f32ffeec763f0bdbf4bec25b52d654f77bff733d/TMessagesProj/src/main/java/org/telegram/messenger/MessageObject.java
src = Path(sys.argv[1]).read_text().rstrip("\n") + "\n"
assert (
    hashlib.sha256(src.encode()).hexdigest()
    == "31d08d6290f9f7cd8f07b7c20c0b2baac84fc1432703080e782af4e03b2299c5"
), "Use the pinned upstream source"
body = src[
    src.index("            int minHeight = dp(120);") : src.index(
        "            int avatarOffset = 108;"
    )
]
s = (
    body.replace("MessageObject.GroupedMessagePosition", "GroupedMessagePosition")
    .replace("Math.", "JMath::")
    .replace("AndroidUtilities.displaySize.x", "displayMin")
    .replace("AndroidUtilities.displaySize.y", "displayMin")
)
s = (
    s.replace("GroupedMessagePosition position", "Pos& position")
    .replace("GroupedMessagePosition pos =", "Pos& pos =")
    .replace("GroupedMessagePosition posToFix = null", "Pos* posToFix = nullptr")
)
s = s.replace("posToFix = pos;", "posToFix = &pos;").replace("posToFix.", "posToFix->")
s = (
    s.replace("String pString", "std::string pString")
    .replace("proportions.toString()", "proportions")
    .replace('pString.equals("ww")', 'pString == "ww"')
    .replace('pString.equals("qq")', 'pString == "qq"')
    .replace("proportions.charAt(0)", "proportions.at(0)")
)
s = s.replace(
    "float[] croppedRatios = new float[posArray.size()]",
    "std::vector<float> croppedRatios(posArray.size())",
)
s = s.replace(
    "ArrayList<MessageGroupedLayoutAttempt> attempts = new ArrayList<>()",
    "List<Attempt> attempts",
)
s = (
    s.replace("new MessageGroupedLayoutAttempt(", "Attempt(")
    .replace("MessageGroupedLayoutAttempt optimal = null", "Attempt* optimal = nullptr")
    .replace(
        "MessageGroupedLayoutAttempt attempt = attempts.get(a)",
        "Attempt& attempt = attempts.get(a)",
    )
    .replace("optimal = attempt;", "optimal = &attempt;")
    .replace("optimal.", "optimal->")
    .replace("optimal == null", "optimal == nullptr")
)
s = s.replace(".length", ".size()").replace(
    "Float.MAX_VALUE", "std::numeric_limits<float>::max()"
)
s = re.sub(r"position1.siblingHeights = new float\[\]\{[^;]+;", "", s)
s = s.replace("return;", "return posArray.values;")
header = """#include <algorithm>
#include <cmath>
#include <iostream>
#include <iomanip>
#include <limits>
#include <string>
#include <vector>
namespace JMath {
 template<class A, class B> auto min(A a,B b) { using T=decltype(a+b); return std::min(T(a),T(b)); }
 template<class A, class B> auto max(A a,B b) { using T=decltype(a+b); return std::max(T(a),T(b)); }
 int round(float a) { return int(std::floor(double(a)+0.5)); }
 float abs(float a) {return std::abs(a);}
}
template<class T> struct List {
 std::vector<T> values;
 int size() {return values.size();}
 T& get(int i) {return values.at(i);}
 void add(T t) {values.push_back(t);}
};
struct Pos {
 float aspectRatio, ph; int minX,maxX,minY,maxY,pw,spanSize,leftSpanOffset;
 void set(int a,int b,int c,int d,int w,float h,int flags) {minX=a;maxX=b;minY=c;maxY=d;pw=w;spanSize=w;ph=h;}
};
struct Attempt {
 std::vector<int> lineCounts;std::vector<float> heights;
 Attempt(int a,int b,float x,float y):lineCounts{a,b},heights{x,y}{}
 Attempt(int a,int b,int c,float x,float y,float z):lineCounts{a,b,c},heights{x,y,z}{}
 Attempt(int a,int b,int c,int d,float x,float y,float z,float w):lineCounts{a,b,c,d},heights{x,y,z,w}{}
};
int maxSizeWidth;
float multiHeight(std::vector<float>& a,int start,int end) {float sum=0;for(int i=start;i<end;i++)sum+=a[i];return maxSizeWidth/sum;}
float density;
int dp(float value) {return int(std::ceil(value*density));}
std::vector<Pos> calculate(std::vector<float> ratios,int displayMin,float d,bool isOut,bool needShare) {
 density=d;maxSizeWidth=needShare?750:800;
 int count=ratios.size(),maxX=0;float maxSizeHeight=814.0f,averageAspectRatio=1.0f;
 bool forceCalc=false,hasSibling=false;std::string proportions;List<Pos> posArray;
 for(float r:ratios) {Pos p{};p.aspectRatio=r;posArray.add(p);averageAspectRatio+=r;forceCalc|=r>2.0f;proportions+=(r>1.2f?'w':r<0.8f?'n':'q');}
 const int POSITION_FLAG_LEFT=1,POSITION_FLAG_RIGHT=2,POSITION_FLAG_TOP=4,POSITION_FLAG_BOTTOM=8;
"""
footer = """
 return posArray.values;
}
int main(){
 int n,displayMin,out,share;float d;
 while(std::cin>>n>>displayMin>>d>>out>>share){std::vector<float> r(n);for(float& v:r)std::cin>>v;
 auto p=calculate(r,displayMin,d,out,share);std::cout<<"[";
 for(int i=0;i<p.size();i++){if(i)std::cout<<",";auto a=p[i];
 std::cout<<"["<<a.minX<<","<<a.maxX<<","<<a.minY<<","<<a.maxY<<","<<a.pw<<","<<std::setprecision(17)<<a.ph<<"]";}
 std::cout<<"]\\n";
 }
}
"""
cases = []
profiles = [(360, 1, False, False), (1080, 3, True, False), (1536, 2, False, True)]
ratios = [0.2, 0.45, 0.8, 1, 1.2, 1.5, 2, 2.001, 4]
for count in range(2, 11):
    for i, ratio in enumerate(ratios):
        display, density, outgoing, share = profiles[i % len(profiles)]
        cases.append(
            dict(
                ratios=[ratio] * count,
                environment=dict(
                    displayMin=display,
                    density=density,
                    outgoing=outgoing,
                    needShare=share,
                ),
            )
        )
for count in [2, 3, 4]:
    for values in itertools.product([0.6, 1, 1.6], repeat=count):
        cases.append(
            dict(
                ratios=list(values),
                environment=dict(
                    displayMin=1080, density=3, outgoing=False, needShare=False
                ),
            )
        )
# Mixed orientations exercise special layouts, the panorama bypass, and minimum widths.
randomizer = random.Random(47281)
for count in range(2, 11):
    for profile in profiles:
        display, density, outgoing, share = profile
        for _ in range(3):
            cases.append(
                dict(
                    ratios=[
                        round(randomizer.uniform(0.15, 4), 3) for _ in range(count)
                    ],
                    environment=dict(
                        displayMin=display,
                        density=density,
                        outgoing=outgoing,
                        needShare=share,
                    ),
                )
            )
inputs = []
for case in cases:
    e = case["environment"]
    inputs.append(
        " ".join(
            map(
                str,
                [
                    len(case["ratios"]),
                    e["displayMin"],
                    e["density"],
                    int(e["outgoing"]),
                    int(e["needShare"]),
                    *case["ratios"],
                ],
            )
        )
    )
with tempfile.TemporaryDirectory() as temp:
    cpp, binary = Path(temp) / "reference.cpp", Path(temp) / "reference"
    cpp.write_text(header + s + footer)
    subprocess.run(
        ["g++", "-std=c++17", "-O0", "-ffp-contract=off", str(cpp), "-o", str(binary)],
        check=True,
    )
    output = subprocess.run(
        [str(binary)],
        input="\n".join(inputs) + "\n",
        text=True,
        capture_output=True,
        check=True,
    ).stdout
for case, line in zip(cases, output.splitlines(), strict=True):
    case["positions"] = json.loads(line)
path = (
    Path(__file__).resolve().parents[1]
    / "src/app/messages/message-attachments/telegram-album-fixtures.json"
)
path.write_text(
    "[\n"
    + ",\n".join(json.dumps(case, separators=(",", ":")) for case in cases)
    + "\n]\n"
)
print(f"Wrote {len(cases)} upstream fixtures to {path}")
