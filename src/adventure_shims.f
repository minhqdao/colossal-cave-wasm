C Host shims for the Colossal Cave Adventure port.
C
C The 1976 original called two PDP-10 system routines that were never
C part of the source snapshot: IFILE (opens the game database) and
C RAN (seeded random numbers, state passed by reference). GETLIN and
C NXTINT support the rewritten database loader, which reads plain
C character records instead of the FORMAT(G,...) records the original
C used.

	SUBROUTINE IFILE(IU,NAME)
C Opens the game database. NAME was the PDP-10 file name ('TEXT') and
C is ignored; the database ships as adventure.dat (embedded into the
C WebAssembly module, or next to the native binary / under src/).
	CHARACTER*(*) NAME
	LOGICAL EXISTS
	INQUIRE(FILE='adventure.dat',EXIST=EXISTS)
	IF(EXISTS) THEN
	OPEN(UNIT=IU,FILE='adventure.dat',STATUS='OLD')
	ELSE
	OPEN(UNIT=IU,FILE='src/adventure.dat',STATUS='OLD')
	END IF
	RETURN
	END

	REAL FUNCTION ADVRAN(QZ)
C Deterministic Park-Miller minimal-standard generator via Schrage's
C method, returning a value in [0,1). QZ is the seed state, passed by
C reference and updated on every call (TOPS-10 RAN semantics).
	INTEGER QZ,HI,LO
	INTEGER A,M,QQR,R
	PARAMETER (A=16807,M=2147483647,QQR=127773,R=2836)
	IF(QZ.LE.0) QZ=1
	HI=QZ/QQR
	LO=MOD(QZ,QQR)
	QZ=A*LO-R*HI
	IF(QZ.LT.0) QZ=QZ+M
	ADVRAN=REAL(QZ)/REAL(M)
	RETURN
	END

	SUBROUTINE GETLIN(IU,CARD,LEN)
C Reads the next record of the database into CARD and returns its
C length with trailing blanks, tabs and carriage returns removed.
C Blank records are skipped (the shipped database contains a stray
C blank line inside the long-text section). LEN is -1 when the file
C is exhausted.
	CHARACTER*200 CARD
 7000	READ(IU,'(A)',END=9000) CARD
	DO 8001 L=200,1,-1
	IF(CARD(L:L).NE.' '.AND.CARD(L:L).NE.CHAR(9)
	1 .AND.CARD(L:L).NE.CHAR(13)) GOTO 8002
 8001	CONTINUE
	GOTO 7000
 8002	LEN=L
	RETURN
 9000	CONTINUE
	LEN=-1
	RETURN
	END

	SUBROUTINE NXTINT(CARD,POS,LEN,VAL,NPOS,FOUND)
C Scans CARD from POS for the next blank/tab-separated integer. FOUND
C is .FALSE. when no digits remain; NPOS always points just past the
C scanned token (or at the end of the record).
	CHARACTER*200 CARD
	LOGICAL FOUND,GOTD
	INTEGER POS,LEN,VAL,NPOS
	INTEGER P,V,D,SIGNV
	FOUND=.FALSE.
	GOTD=.FALSE.
	V=0
	SIGNV=1
	P=POS
   10	IF(P.GT.LEN) GOTO 80
	IF(CARD(P:P).NE.' '.AND.CARD(P:P).NE.CHAR(9)) GOTO 20
	P=P+1
	GOTO 10
   20	IF(CARD(P:P).NE.'-') GOTO 30
	SIGNV=-1
	P=P+1
   30	IF(P.GT.LEN) GOTO 80
	D=ICHAR(CARD(P:P))-ICHAR('0')
	IF(D.LT.0.OR.D.GT.9) GOTO 80
	V=V*10+D
	GOTD=.TRUE.
	P=P+1
	GOTO 30
   80	IF(.NOT.GOTD) GOTO 90
	VAL=SIGNV*V
	NPOS=P
	FOUND=.TRUE.
	RETURN
   90	VAL=0
	NPOS=P
	RETURN
	END
